import { afterEach, describe, expect, it } from "vitest";
import { createServer, Server } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { withApplicationConnection } from "../src/utils/ConnectionManager.js";

const priorDirectory = process.env.CIVIL3D_CONNECTION_DIR;
const priorPid = process.env.CIVIL3D_INSTANCE_PID;
let tempDirectory: string | undefined;
let pipeServer: Server | undefined;

afterEach(async () => {
  pipeServer?.close();
  pipeServer = undefined;
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  tempDirectory = undefined;
  if (priorDirectory === undefined) delete process.env.CIVIL3D_CONNECTION_DIR;
  else process.env.CIVIL3D_CONNECTION_DIR = priorDirectory;
  if (priorPid === undefined) delete process.env.CIVIL3D_INSTANCE_PID;
  else process.env.CIVIL3D_INSTANCE_PID = priorPid;
});

describe("native host session connection", () => {
  it("discovers a temporary descriptor and sends session credentials in the JSON-RPC envelope", async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "c3d-host-session-"));
    process.env.CIVIL3D_CONNECTION_DIR = tempDirectory;
    process.env.CIVIL3D_INSTANCE_PID = String(process.pid);

    const pipeName = "Civil3DMcpTest-" + randomBytes(8).toString("hex");
    const pipePath = "\\\\.\\pipe\\" + pipeName;
    const descriptor = {
      protocol: 1,
      pid: process.pid,
      pipeName,
      sessionId: randomUUID(),
      token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(tempDirectory, `${process.pid}.json`), JSON.stringify(descriptor), "utf8");

    let resolveRequest!: (request: Record<string, unknown>) => void;
    const received = new Promise<Record<string, unknown>>((resolve) => { resolveRequest = resolve; });
    pipeServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        try {
          const request = JSON.parse(buffer) as Record<string, unknown>;
          resolveRequest(request);
          socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { connected: true } }));
        } catch {
          // The production protocol has no delimiter; wait until the JSON object is complete.
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      pipeServer!.once("error", reject);
      pipeServer!.listen(pipePath, resolve);
    });

    const result = await withApplicationConnection((client) => client.sendCommand("getHostSession", {}));
    const request = await received;
    expect(result).toEqual({ connected: true });
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "getHostSession",
      params: {},
      auth: { sessionId: descriptor.sessionId, token: descriptor.token },
    });
    expect(await readFile(path.join(tempDirectory, `${process.pid}.json`), "utf8")).toContain(descriptor.sessionId);
  });
});
