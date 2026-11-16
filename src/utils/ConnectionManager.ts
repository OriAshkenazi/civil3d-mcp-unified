// Production transport for commands to the native Civil 3D host: resolve one descriptor, open one authenticated
// current-user named pipe, send one request, then disconnect. Descriptors are never cached between operations.
import { ApplicationClientConnection, Civil3DRpcError } from "./SocketClient.js";
import { createLogger } from "./logger.js";
import { currentAbortSignal } from "./requestContext.js";
import { discoverHostConnection } from "./connectionDiscovery.js";

const log = createLogger("ConnectionManager");

const CONNECT_TIMEOUT_MS = parseInt(process.env.CIVIL3D_CONNECT_TIMEOUT ?? "5000", 10);

/** What a domain action sees: send a plugin method (a CommandDispatcher.cs name) with params, get its `result`. */
export interface ApplicationCommandClient {
  sendCommand(command: string, params?: unknown): Promise<any>;
}

/**
 * Runs an operation against the selected native host. Each sendCommand gets its own short-lived pipe connection.
 */
export async function withApplicationConnection<T>(
  operation: (client: ApplicationCommandClient) => Promise<T>
): Promise<T> {
  const client: ApplicationCommandClient = {
    sendCommand: async (command, params = {}) => await sendSingleCommand(command, params),
  };

  return await operation(client);
}

/**
 * Connects, sends one command, waits for the answer, and always disconnects. Throws "Failed to connect ..." or
 * "... timed out" when the plugin isn't listening (AI connection off, Civil 3D closed), the plugin's Civil3DRpcError
 * for an error answer, and CIVIL3D.CANCELLED when the caller aborted at any point (that error wins over whatever the
 * aborted socket reported).
 */
async function sendSingleCommand(command: string, params: unknown): Promise<any> {
  const signal = currentAbortSignal();
  const descriptor = await discoverHostConnection();
  const appClient = new ApplicationClientConnection("\\\\.\\pipe\\" + descriptor.pipeName, undefined, {
    sessionId: descriptor.sessionId,
    token: descriptor.token,
  });
  const cancellationError = new Civil3DRpcError(
    `Civil 3D command '${command}' was cancelled by the caller.`,
    "CIVIL3D.CANCELLED",
    -32010,
  );
  const cancel = () => appClient.cancel(cancellationError);

  try {
    if (signal?.aborted) throw cancellationError;
    signal?.addEventListener("abort", cancel, { once: true });
    if (!appClient.isConnected) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timeout);
          appClient.socket.removeListener("connect", onConnect);
          appClient.socket.removeListener("error", onError);
        };

        const onConnect = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          log.error("Connection failed", {
            endpoint: "current-user named pipe",
            error: error.message,
          });
          reject(new Error(`Failed to connect to the selected Civil 3D named pipe`));
        };

        appClient.socket.on("connect", onConnect);
        appClient.socket.on("error", onError);

        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          appClient.socket.destroy();
          log.warn("Connection timed out", { endpoint: "current-user named pipe", timeoutMs: CONNECT_TIMEOUT_MS });
          reject(new Error(`Connection to Civil 3D plugin timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);

        if (!appClient.connect()) {
          onError(new Error("Socket connect call failed."));
        }
      });
    }

    return await appClient.sendCommand(command, params);
  } catch (error) {
    if (signal?.aborted) throw cancellationError;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    appClient.disconnect();
  }
}
