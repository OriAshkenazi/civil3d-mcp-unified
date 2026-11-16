// Per-process credentials and a current-user-only discovery descriptor.
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Civil3DMcpPlugin;

internal sealed class HostSessionDescriptor
{
  internal int Protocol { get; } = 1;
  internal int Pid { get; } = Environment.ProcessId;
  internal string PipeName { get; } = "Civil3DMcp-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
  internal string SessionId { get; } = Guid.NewGuid().ToString();
  internal string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
  internal DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
  internal string DescriptorPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Civil3DMcp", "connections", $"{Pid}.json");

  internal bool Authenticate(JsonNode? auth)
  {
    if (auth is not JsonObject obj || obj["sessionId"] is not JsonValue sid || obj["token"] is not JsonValue tok ||
        !sid.TryGetValue<string>(out var session) || !tok.TryGetValue<string>(out var token)) return false;
    if (session == null || token == null || session.Length != SessionId.Length || token.Length != Token.Length) return false;
    var expected = Encoding.UTF8.GetBytes(Token);
    var supplied = Encoding.UTF8.GetBytes(token);
    var expectedId = Encoding.UTF8.GetBytes(SessionId);
    var suppliedId = Encoding.UTF8.GetBytes(session);
    return suppliedId.Length == expectedId.Length && CryptographicOperations.FixedTimeEquals(suppliedId, expectedId)
      && supplied.Length == expected.Length && CryptographicOperations.FixedTimeEquals(supplied, expected);
  }

  // Every component is checked before use. The restricted directory inherits only this user's full-control ACE.
  internal void Publish()
  {
    var basePath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    CheckNoReparse(basePath);
    var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("No Windows user SID.");
    var security = new DirectorySecurity();
    security.SetOwner(owner);
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    var root = Path.Combine(basePath, "Civil3DMcp");
    CreateRestricted(root, security);
    var dir = Path.Combine(root, "connections");
    CreateRestricted(dir, security);
    var path = DescriptorPath;
    if (File.Exists(path))
    {
      CheckNoReparse(path);
      File.Delete(path);
    }
    // CreateNew prevents writing through a pre-existing link; the directory ACL supplies the file ACL at creation.
    using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
    JsonSerializer.Serialize(file, new { protocol = Protocol, pid = Pid, pipeName = PipeName,
      sessionId = SessionId, token = Token, createdAt = CreatedAt });
    file.Flush(true);
  }

  internal void Remove()
  {
    var path = DescriptorPath;
    if (!File.Exists(path)) return;
    CheckNoReparse(path);
    File.Delete(path);
  }

  private static void CreateRestricted(string path, DirectorySecurity security)
  {
    if (Directory.Exists(path)) CheckNoReparse(path);
    new DirectoryInfo(path).Create(security);
    CheckNoReparse(path);
    new DirectoryInfo(path).SetAccessControl(security);
  }

  private static void CheckNoReparse(string path)
  {
    var current = Path.GetFullPath(path);
    while (!string.IsNullOrEmpty(current))
    {
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Reparse points are not permitted in the session descriptor path.");
      current = Path.GetDirectoryName(current) ?? string.Empty;
    }
  }
}
