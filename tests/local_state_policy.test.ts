// Regression for the audit's anonymous preference-persistence path, through the real tool runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ policy: "inspect" }));
vi.mock("../src/utils/hostSession.js", () => ({
  requireHostPolicy: async () => {
    if (state.policy === "inspect") throw Object.assign(new Error("Host authorization is required."), { code: "CIVIL3D.HOST_POLICY_REQUIRED" });
    return { policy: state.policy, sessionId: "unit-test", scope: "unit-test" };
  },
}));

import { captureDomainToolHandlers } from "../src/tools/domainRuntime.js";
import { SCRIPTING_DOMAIN_DEFINITION } from "../src/tools/domains/scriptingDomain.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";
import { listPreferences, preferencesFile } from "../src/tools/knowledgeBase.js";

describe("host authorization for Node-owned state", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "c3d-local-policy-"));
    vi.stubEnv("CIVIL3D_MCP_KNOWLEDGE_DIR", root);
    state.policy = "inspect";
    captureDomainToolHandlers(SCRIPTING_DOMAIN_DEFINITION);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  it("refuses persistence before executing a register action under Inspect", async () => {
    const result = await getToolHandler("civil3d_preferences")!({ action: "add", rule: "Use concise explanations." });
    expect(result).toMatchObject({ isError: true, errorCode: "CIVIL3D.HOST_POLICY_REQUIRED" });
    expect(existsSync(preferencesFile())).toBe(false);
  });
  it("retains preference persistence after a live host grants Edit", async () => {
    state.policy = "edit";
    const result = await getToolHandler("civil3d_preferences")!({ action: "add", rule: "Use concise explanations." });
    expect(result.isError).not.toBe(true);
    expect(listPreferences().map((item) => item.rule)).toEqual(["Use concise explanations."]);
  });
});
