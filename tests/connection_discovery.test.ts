// Validates descriptor discovery against isolated temporary directories; never reads the user's real host directory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverHostConnection } from "../src/utils/connectionDiscovery.js";

const VALID_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const VALID_TOKEN = "ab".repeat(32);

let root = "";
let originalDirectory: string | undefined;
let originalLocalAppData: string | undefined;
let originalPid: string | undefined;
let killSpy: ReturnType<typeof vi.spyOn>;

function descriptor(pid: number, updates: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    pid,
    pipeName: "Civil3DMcp-test",
    sessionId: VALID_SESSION,
    token: VALID_TOKEN,
    createdAt: new Date().toISOString(),
    ...updates,
  };
}

async function publish(pid: number, value: unknown = descriptor(pid)) {
  await writeFile(path.join(root, pid + ".json"), JSON.stringify(value), "utf8");
}

function useDirectory() {
  process.env.CIVIL3D_CONNECTION_DIR = root;
  delete process.env.LOCALAPPDATA;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "c3d-connection-discovery-"));
  originalDirectory = process.env.CIVIL3D_CONNECTION_DIR;
  originalLocalAppData = process.env.LOCALAPPDATA;
  originalPid = process.env.CIVIL3D_INSTANCE_PID;
  useDirectory();
  delete process.env.CIVIL3D_INSTANCE_PID;
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(async () => {
  killSpy.mockRestore();
  if (originalDirectory === undefined) delete process.env.CIVIL3D_CONNECTION_DIR;
  else process.env.CIVIL3D_CONNECTION_DIR = originalDirectory;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalPid === undefined) delete process.env.CIVIL3D_INSTANCE_PID;
  else process.env.CIVIL3D_INSTANCE_PID = originalPid;
  await rm(root, { recursive: true, force: true });
});

describe("native host descriptor discovery", () => {
  it("treats a blank optional bundle PID as automatic live-instance discovery", async () => {
    await publish(40201);
    process.env.CIVIL3D_INSTANCE_PID = "";
    await expect(discoverHostConnection()).resolves.toMatchObject({ pid: 40201 });
  });
  it("selects the only descriptor and validates its native credentials", async () => {
    await publish(40201);
    await expect(discoverHostConnection()).resolves.toMatchObject({
      protocol: 1,
      pid: 40201,
      pipeName: "Civil3DMcp-test",
      sessionId: VALID_SESSION,
      token: VALID_TOKEN,
    });
    expect(killSpy).toHaveBeenCalledWith(40201, 0);
  });

  it.each([
    ["protocol", { protocol: 2 }],
    ["token", { token: "not-a-64-character-hex-token" }],
    ["pipe path", { pipeName: "\\\\server\\pipe\\remote" }],
  ])("rejects a malformed %s", async (_name, update) => {
    await publish(40202, descriptor(40202, update));
    await expect(discoverHostConnection()).rejects.toThrow(/malformed|unsafe .*named pipe/i);
  });

  it("rejects descriptor files that are not regular files", async () => {
    await mkdir(path.join(root, "40203.json"));
    await expect(discoverHostConnection()).rejects.toThrow(/regular, non-link file/i);
  });

  it("rejects a descriptor symbolic link", async () => {
    const target = path.join(root, "target.json");
    await writeFile(target, JSON.stringify(descriptor(40204)));
    try {
      await symlink(target, path.join(root, "40204.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(discoverHostConnection()).rejects.toThrow(/regular, non-link file/i);
  });

  it("rejects a descriptor directory reached through a parent junction or symlink", async () => {
    const alias = path.join(root, "alias");
    try {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await publish(40205);
    process.env.CIVIL3D_CONNECTION_DIR = alias;
    await expect(discoverHostConnection()).rejects.toThrow(/symlink, junction/i);
  });

  it("bounds the descriptor read and rejects an oversized file", async () => {
    await writeFile(path.join(root, "40206.json"), " ".repeat(32 * 1024));
    await expect(discoverHostConnection()).rejects.toThrow(/too large/i);
  });

  it("rejects a descriptor whose process is stale", async () => {
    await publish(40207);
    process.env.CIVIL3D_INSTANCE_PID = "40207";
    killSpy.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(discoverHostConnection()).rejects.toThrow(/no longer running/i);
  });

  it("ignores a definitively stale descriptor when one live host is available", async () => {
    await publish(40210);
    await publish(40211);
    killSpy.mockImplementation((pid) => {
      if (pid === 40210) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    await expect(discoverHostConnection()).resolves.toMatchObject({ pid: 40211 });
  });

  it("requires an explicit PID when multiple hosts are present, then selects that PID", async () => {
    await publish(40208);
    await publish(40209);
    await expect(discoverHostConnection()).rejects.toThrow(/multiple (?:live )?Civil 3D instances/i);
    process.env.CIVIL3D_INSTANCE_PID = "40209";
    await expect(discoverHostConnection()).resolves.toMatchObject({ pid: 40209 });
  });

  it("requires an absolute safe directory and does not fall back to the current working directory", async () => {
    process.env.CIVIL3D_CONNECTION_DIR = "relative-connections";
    await expect(discoverHostConnection()).rejects.toThrow(/absolute path/i);

    delete process.env.CIVIL3D_CONNECTION_DIR;
    delete process.env.LOCALAPPDATA;
    await expect(discoverHostConnection()).rejects.toThrow(/absolute path/i);
  });

  it("rejects parent-directory traversal in a configured directory", async () => {
    process.env.CIVIL3D_CONNECTION_DIR = root + path.sep + ".." + path.sep + "connections";
    await expect(discoverHostConnection()).rejects.toThrow(/parent-directory segments/i);
  });

  it("reports the empty directory without selecting a process", async () => {
    await expect(discoverHostConnection()).rejects.toThrow(/No Civil 3D connection descriptor/i);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
