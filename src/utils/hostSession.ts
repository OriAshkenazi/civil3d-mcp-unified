/** Reads native host policy for each sensitive decision; Node cannot grant edit or automation authority itself. */
import { withApplicationConnection } from "./ConnectionManager.js";

export type HostPolicy = "inspect" | "edit" | "auto";
export interface HostSession {
  policy: HostPolicy;
  sessionId: string;
  scope: string;
}

const POLICY_RANK: Record<HostPolicy, number> = { inspect: 0, edit: 1, auto: 2 };

/** Retrieves current policy from the native host and rejects a decision the user has not granted in Civil 3D. */
export async function requireHostPolicy(required: "edit" | "auto"): Promise<HostSession> {
  const session = await withApplicationConnection((client) => client.sendCommand("getHostSession", {})) as Partial<HostSession>;
  if (!session || !["inspect", "edit", "auto"].includes(String(session.policy))
    || typeof session.sessionId !== "string" || typeof session.scope !== "string") {
    throw new Error("Civil 3D returned an invalid host session policy.");
  }
  if (POLICY_RANK[session.policy as HostPolicy] < POLICY_RANK[required]) {
    const error = new Error("Civil 3D host policy is " + session.policy + "; this action requires " + required
      + ". Run C3DMCPAUTHORIZE in Civil 3D and choose " + (required === "auto" ? "Auto" : "Edit") + ", then retry.");
    Object.assign(error, { code: "CIVIL3D.HOST_POLICY_REQUIRED", rpcCode: -32062 });
    throw error;
  }
  return session as HostSession;
}
