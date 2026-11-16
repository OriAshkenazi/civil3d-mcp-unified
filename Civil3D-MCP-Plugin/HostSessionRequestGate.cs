// Guards handler invocation with the current session credentials and host policy.
using System.Text.Json.Nodes;
namespace Civil3DMcpPlugin;

internal sealed class HostSessionGateException : Exception
{
  internal string Code { get; }
  internal HostSessionGateException(string code, string message) : base(message) => Code = code;
}

internal static class HostSessionRequestGate
{
  internal static async Task<T> ExecuteAsync<T>(HostSessionDescriptor? session, JsonNode? auth, string method, Func<Task<T>> handler)
  {
    if (session == null || !session.Authenticate(auth))
      throw new HostSessionGateException("CIVIL3D.AUTH_REQUIRED", "Valid session credentials are required.");
    if (!HostSessionPolicy.IsKnown(method))
      throw new HostSessionGateException("CIVIL3D.METHOD_NOT_FOUND", "Unknown plugin method.");
    if (!HostSessionPolicy.Allows(method))
      throw new HostSessionGateException("CIVIL3D.FORBIDDEN", "The host session policy does not authorize this operation. Use C3DMCPAUTHORIZE locally.");
    return await handler();
  }
}
