// Repo-boundary test (CLAUDE.md rule 5): plugin file writes go through FileBoundary.cs, FileBoundary canonicalizes
// paths and writes by atomic move, and JSON-RPC errors keep their domain code in error.data.code. Reads the plugin
// source as text; no Civil 3D. The behaviour itself is run by tests/FileBoundaryHarness (npm run test:p2-boundaries).

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDirectory = fileURLToPath(new URL("../Civil3D-MCP-Plugin/", import.meta.url));

describe("P2 security boundaries", () => {
  it("keeps generated artifact writes behind FileBoundary", () => {
    const directWritePattern = /File\.WriteAllText|new (?:System\.IO\.)?StreamWriter|new (?:System\.IO\.)?FileStream/;
    const violations: string[] = [];

    for (const fileName of readdirSync(pluginDirectory).filter((name) => name.endsWith(".cs"))) {
      // HostSessionDescriptor is the narrowly scoped exception: it must create a current-user-only
      // authentication descriptor at a fixed LocalAppData path, not an artifact under user-selected roots.
      if (fileName === "FileBoundary.cs" || fileName === "PluginLog.cs" || fileName === "HostSessionDescriptor.cs") continue;
      const source = readFileSync(`${pluginDirectory}/${fileName}`, "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (directWritePattern.test(line)) violations.push(`${fileName}:${index + 1}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it("restricts the native host-session descriptor write to its fixed current-user location", () => {
    const source = readFileSync(`${pluginDirectory}/HostSessionDescriptor.cs`, "utf8");
    expect(source).toContain("Environment.SpecialFolder.LocalApplicationData");
    expect(source).toContain("FileMode.CreateNew");
    expect(source).toContain("FileAttributes.ReparsePoint");
    expect(source).toContain("FileSystemAccessRule(owner, FileSystemRights.FullControl");
    expect(source).toContain("FileShare.Read");
  });

  it("canonicalizes paths, enforces roots and extensions, and writes by atomic move", () => {
    const source = readFileSync(`${pluginDirectory}/FileBoundary.cs`, "utf8");
    expect(source).toContain("Path.GetFullPath");
    expect(source).toContain("Path.GetRelativePath");
    expect(source).toContain("CIVIL3D_IMPORT_ROOTS");
    expect(source).toContain("CIVIL3D_EXPORT_ROOTS");
    expect(source).toContain("CIVIL3D.PATH_NOT_ALLOWED");
    expect(source).toContain("CIVIL3D.FILE_TYPE_NOT_ALLOWED");
    expect(source).toContain("FileAttributes.ReparsePoint");
    expect(source).toContain("File.Move(tempPath, path, overwrite)");
    expect(source).toContain("Set overwrite=true");
  });

  it("uses JSON-RPC numeric errors and retains domain identifiers in error.data.code", () => {
    const source = readFileSync(`${pluginDirectory}/JsonRpcProtocol.cs`, "utf8");
    expect(source).toContain('["code"] = numericCode');
    expect(source).toContain('["data"] = new JsonObject');
    expect(source).toContain('["code"] = domainCode');
    expect(source).toContain('"CIVIL3D.METHOD_NOT_FOUND" => -32601');
    expect(source).toContain('"CIVIL3D.INVALID_INPUT" => -32602');
  });
});
