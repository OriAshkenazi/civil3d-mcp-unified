// Disposable discovery descriptor for integration tests of the real named-pipe client.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/** Makes an audit-owned descriptor for an inert pipe server, never a real Civil 3D instance. */
export function mockHostDescriptor() {
  const root = mkdtempSync(path.join(tmpdir(), "civil3d-mcp-pipe-test-"));
  const descriptor = {
    protocol: 1,
    pid: process.pid,
    pipeName: `Civil3DMcp-test-${randomUUID()}`,
    sessionId: randomUUID(),
    token: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(root, `${process.pid}.json`), JSON.stringify(descriptor));
  return {
    root, descriptor,
    pipePath: `\\\\.\\pipe\\${descriptor.pipeName}`,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
