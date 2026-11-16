// A real MCP initialization must work while the HTTP bridge stays closed by default.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("production HTTP startup policy", () => {
  it("initializes the real stdio server without opening HTTP when opt-in is absent", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const root = await mkdtemp(path.join(os.tmpdir(), "c3d-http-disabled-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    delete env.MCP_HTTP_ENABLED;
    delete env.MCP_HTTP_TOKEN;
    Object.assign(env, {
      MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1",
      PROJECT_KNOWLEDGE_DIR: root, CIVIL3D_MCP_KNOWLEDGE_DIR: path.join(root, "civil3d"),
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["build/index.js"], cwd: process.cwd(), env, stderr: "pipe" });
    const client = new Client({ name: "http-default-security-test", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const result = await new Promise<string>((resolve) => {
        const probe = request({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (response) => {
          response.resume(); resolve("HTTP_OPEN");
        });
        probe.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
        probe.on("timeout", () => { probe.destroy(); resolve("TIMEOUT"); });
        probe.end();
      });
      expect(result).toBe("ECONNREFUSED");
    } finally {
      await client.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
