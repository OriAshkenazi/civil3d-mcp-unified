// Authenticated current-user named pipe transport.
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Civil3DMcpPlugin;

/// <summary>One authenticated request per current-user named-pipe connection.</summary>
public sealed class RpcPipeServer
{
  private const int MaxRequestBytes = 1024 * 1024;
  private static readonly TimeSpan RequestReadTimeout = TimeSpan.FromSeconds(30);

  private readonly string _pipeName;
  private readonly Func<string, CancellationToken, Task<string>> _handler;
  private readonly CancellationTokenSource _cts = new();
  private NamedPipeServerStream? _listener;
  private Task? _acceptLoop;

  /// <summary>Creates the listener without binding it; <see cref="Start"/> binds.</summary>
  /// <param name="pipeName">Random per-session pipe name.</param>
  /// <param name="handler">Takes the raw request text and a cancellation token, returns the serialized JSON-RPC
  /// response (PluginRuntime.HandleRawRequestAsync).</param>
  public RpcPipeServer(string pipeName, Func<string, CancellationToken, Task<string>> handler)
  {
    _pipeName = pipeName;
    _handler = handler;
  }

  /// <summary>Creates a current-user-only pipe and starts accepting.</summary>
  public void Start()
  {
    _listener = CreatePipe();
    _acceptLoop = Task.Run(AcceptLoopAsync, _cts.Token);
  }

  /// <summary>Stops accepting and cancels in-flight reads; waits up to a second for the accept loop.</summary>
  public void Stop()
  {
    try
    {
      _cts.Cancel();
      _listener?.Dispose();
      _acceptLoop?.Wait(TimeSpan.FromSeconds(1));
    }
    catch
    {
    }
  }

  private NamedPipeServerStream CreatePipe() => new(_pipeName, PipeDirection.InOut,
    NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

  /// <summary>Accepts connections until stopped and hands each one to its own <see cref="ProcessClientAsync"/> task.
  /// Requests are not serialized here: ordering and one-at-a-time drawing access come from the host gate
  /// (CivilExecution) that every handler goes through.</summary>
  private async Task AcceptLoopAsync()
  {
    while (!_cts.IsCancellationRequested)
    {
      NamedPipeServerStream? client = null;
      try
      {
        client = _listener ?? CreatePipe();
        _listener = client;
        await client.WaitForConnectionAsync(_cts.Token);
        _listener = null;
        _ = Task.Run(() => ProcessClientAsync(client, _cts.Token));
      }
      catch (OperationCanceledException) { client?.Dispose(); break; }
      catch (ObjectDisposedException) when (_cts.IsCancellationRequested) { break; }
      catch { client?.Dispose(); if (!_cts.IsCancellationRequested) await Task.Delay(100); }

    }
  }

  /// <summary>Reads one request, runs the handler while watching for disconnect, and writes the answer unless the
  /// client has left. Errors are logged; a malformed request gets a JSON-RPC error, never an exception.</summary>
  private async Task ProcessClientAsync(NamedPipeServerStream client, CancellationToken cancellationToken)
  {
    try
    {
      await using (var stream = client)
      {
        string request;
        try
        {
          request = await ReadSingleJsonObjectAsync(stream, cancellationToken);
        }
        catch (DecoderFallbackException)
        {
          // Reject instead of silently replacing bytes with U+FFFD (e.g. a Windows-1252 degree sign).
          PluginLog.Warn("RpcPipeServer", "Rejected a request that is not valid UTF-8.");
          var error = JsonRpcProtocol.SerializeError(
            null,
            -32700,
            "CIVIL3D.INVALID_REQUEST",
            "Request is not valid UTF-8. Send the JSON-RPC request encoded as UTF-8 (characters such as ° ± ² Ø are supported).");
          await stream.WriteAsync(Encoding.UTF8.GetBytes(error), cancellationToken);
          await stream.FlushAsync(cancellationToken);
          return;
        }

        if (string.IsNullOrWhiteSpace(request))
        {
          return;
        }

        using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var disconnectMonitorCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var disconnectMonitor = MonitorClientDisconnectAsync(
          stream,
          requestCancellation,
          disconnectMonitorCancellation.Token);

        var response = await _handler(request, requestCancellation.Token);
        disconnectMonitorCancellation.Cancel();
        var clientDisconnected = await disconnectMonitor;
        if (clientDisconnected)
        {
          PluginLog.Debug("RpcPipeServer", "Skipped response write because the client disconnected.");
          return;
        }

        var responseBytes = Encoding.UTF8.GetBytes(response);
        await stream.WriteAsync(responseBytes, cancellationToken);
        await stream.FlushAsync(cancellationToken);
      }
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      // Normal plugin shutdown.
    }
    catch (TimeoutException)
    {
      PluginLog.Warn("RpcPipeServer", $"Closed a client that did not send a complete request within {RequestReadTimeout.TotalSeconds:0} seconds.");
    }
    catch (OperationCanceledException)
    {
      PluginLog.Debug("RpcPipeServer", "Client disconnected and its queued request was cancelled.");
    }
    catch (InvalidDataException ex)
    {
      PluginLog.Warn("RpcPipeServer", ex.Message);
    }
    catch (Exception ex)
    {
      PluginLog.Error("RpcPipeServer", "Client request processing failed.", ex);
    }
  }

  // Throws DecoderFallbackException on invalid UTF-8 instead of substituting U+FFFD.
  private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

  /// <summary>
  /// Reads until the bytes received so far parse as one JSON document (there is no length prefix or delimiter; the
  /// client doesn't close its side until it has the answer). Over the size limit is InvalidDataException; no complete
  /// request within the read timeout is TimeoutException.
  /// </summary>
  private static async Task<string> ReadSingleJsonObjectAsync(Stream stream, CancellationToken cancellationToken)
  {
    var buffer = new byte[8192];
    using var requestBuffer = new MemoryStream();
    using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    readTimeout.CancelAfter(RequestReadTimeout);

    try
    {
      while (!readTimeout.IsCancellationRequested)
      {
        var bytesRead = await stream.ReadAsync(buffer, readTimeout.Token);
        if (bytesRead <= 0)
        {
          break;
        }

        if (requestBuffer.Length + bytesRead > MaxRequestBytes)
        {
          throw new InvalidDataException($"RPC request exceeds the {MaxRequestBytes}-byte limit.");
        }

        await requestBuffer.WriteAsync(buffer.AsMemory(0, bytesRead), readTimeout.Token);
        var requestBytes = requestBuffer.GetBuffer();
        var requestLength = checked((int)requestBuffer.Length);

        try
        {
          using var _ = JsonDocument.Parse(
            new ReadOnlyMemory<byte>(requestBytes, 0, requestLength));
          return StrictUtf8.GetString(requestBytes, 0, requestLength);
        }
        catch (JsonException)
        {
        }
      }
    }
    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && readTimeout.IsCancellationRequested)
    {
      throw new TimeoutException("RPC request read timed out.");
    }

    return StrictUtf8.GetString(
      requestBuffer.GetBuffer(),
      0,
      checked((int)requestBuffer.Length));
  }

  /// <summary>Watches the connection during a request; on end of stream or a socket error it cancels the request and
  /// returns true (the response is then not written).</summary>
  private static async Task<bool> MonitorClientDisconnectAsync(
    Stream stream,
    CancellationTokenSource requestCancellation,
    CancellationToken monitorCancellation)
  {
    var probe = new byte[1];
    try
    {
      while (!monitorCancellation.IsCancellationRequested)
      {
        var bytesRead = await stream.ReadAsync(probe, monitorCancellation);
        if (bytesRead == 0)
        {
          requestCancellation.Cancel();
          return true;
        }

        // The protocol permits one JSON request per connection. Ignore any
        // trailing bytes while continuing to watch for the peer's FIN.
      }
    }
    catch (OperationCanceledException) when (monitorCancellation.IsCancellationRequested)
    {
      return false;
    }
    catch (IOException)
    {
      requestCancellation.Cancel();
      return true;
    }

    return false;
  }
}
