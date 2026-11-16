/** Discovers the current user's native Civil 3D pipe descriptor and rejects ambiguous or unsafe endpoints. */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export interface HostConnectionDescriptor {
  protocol: 1;
  pid: number;
  pipeName: string;
  sessionId: string;
  token: string;
  createdAt: string;
}

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A descriptor is structurally valid, but its process is definitively gone (ESRCH). */
class DeadHostProcessError extends Error {}

function connectionDirectory(): string {
  const configured = process.env.CIVIL3D_CONNECTION_DIR;
  const localAppData = process.env.LOCALAPPDATA;
  const directory = configured ?? (localAppData ? path.join(localAppData, "Civil3DMcp", "connections") : "");
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("Civil 3D connection directory must be an absolute path; set CIVIL3D_CONNECTION_DIR or LOCALAPPDATA.");
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(directory)) {
    throw new Error("Civil 3D connection directory cannot contain parent-directory segments.");
  }
  if (process.platform === "win32" ? /^\\\\/.test(directory) : directory.startsWith("//")) {
    throw new Error("Civil 3D connection directory must be local, not a network path.");
  }
  return path.resolve(directory);
}

/** Rejects symlinked directories and junctions in every component of the configured descriptor path. */
async function assertSafeDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  if (!path.isAbsolute(absolute)) throw new Error("Civil 3D connection directory must be absolute.");
  const root = path.parse(absolute).root;
  let current = root;
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Civil 3D connection directory has an unsafe root.");
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Civil 3D connection directory contains a symlink, junction, or non-directory component.");
    }
  }
}

function validateDescriptor(value: unknown, expectedPid: number): HostConnectionDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Civil 3D connection descriptor.");
  const d = value as Record<string, unknown>;
  if (d.protocol !== 1 || d.pid !== expectedPid || typeof d.pipeName !== "string"
    || typeof d.sessionId !== "string" || !UUID.test(d.sessionId)
    || typeof d.token !== "string" || !/^[0-9a-f]{64}$/i.test(d.token)
    || typeof d.createdAt !== "string" || !Number.isFinite(Date.parse(d.createdAt))) {
    throw new Error("Malformed Civil 3D connection descriptor.");
  }
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(d.pipeName) || d.pipeName.includes("..") || d.pipeName.includes("/")) {
    throw new Error("Unsafe Civil 3D named pipe in connection descriptor.");
  }
  return {
    protocol: 1,
    pid: expectedPid,
    pipeName: d.pipeName,
    sessionId: d.sessionId,
    token: d.token,
    createdAt: d.createdAt,
  };
}

async function readDescriptor(file: string, pid: number): Promise<HostConnectionDescriptor> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Civil 3D connection descriptor must be a regular, non-link file.");
  if (before.size > MAX_DESCRIPTOR_BYTES) throw new Error("Civil 3D connection descriptor is too large.");

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  let content: string;
  try {
    const stat = await handle.stat();
    const after = await lstat(file);
    if (!stat.isFile() || after.isSymbolicLink() || stat.dev !== after.dev || stat.ino !== after.ino) {
      throw new Error("Civil 3D connection descriptor changed during secure open.");
    }
    if (stat.size > MAX_DESCRIPTOR_BYTES) throw new Error("Civil 3D connection descriptor is too large.");
    const bounded = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    let total = 0;
    while (total < bounded.length) {
      const { bytesRead } = await handle.read(bounded, total, bounded.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_DESCRIPTOR_BYTES) throw new Error("Civil 3D connection descriptor is too large.");
    content = bounded.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
  const descriptor = validateDescriptor(JSON.parse(content), pid);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new DeadHostProcessError("Civil 3D process " + pid + " is no longer running.");
    }
    throw error;
  }
  return descriptor;
}

/** Selects only an explicit PID, or the sole published instance; never guesses among multiple hosts. */
export async function discoverHostConnection(): Promise<HostConnectionDescriptor> {
  const directory = connectionDirectory();
  try {
    await assertSafeDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No Civil 3D connection descriptor is available. Start the native connection in Civil 3D.");
    }
    throw error;
  }
  // Optional MCP-bundle settings serialize an unselected PID as an empty string.
  const requestedPidRaw = process.env.CIVIL3D_INSTANCE_PID?.trim() || undefined;
  if (requestedPidRaw !== undefined) {
    if (!/^\d+$/.test(requestedPidRaw) || Number(requestedPidRaw) < 1) throw new Error("CIVIL3D_INSTANCE_PID must be a positive process ID.");
    const pid = Number(requestedPidRaw);
    return await readDescriptor(path.join(directory, String(pid) + ".json"), pid);
  } else {
    let files: string[];
    try { files = (await readdir(directory)).filter((name) => /^\d+\.json$/.test(name)); }
    catch { throw new Error("No Civil 3D connection descriptor is available. Start the native connection in Civil 3D."); }
    if (files.length === 0) throw new Error("No Civil 3D connection descriptor is available. Start the native connection in Civil 3D.");
    const live: HostConnectionDescriptor[] = [];
    for (const file of files) {
      const pid = Number(file.slice(0, -5));
      try {
        live.push(await readDescriptor(path.join(directory, file), pid));
      } catch (error) {
        if (error instanceof DeadHostProcessError) continue;
        throw error;
      }
    }
    if (live.length === 0) throw new Error("No live Civil 3D connection descriptor is available. Start the native connection in Civil 3D.");
    if (live.length > 1) throw new Error("Multiple live Civil 3D instances are available. Set CIVIL3D_INSTANCE_PID to the intended process ID.");
    return live[0];
  }
}
