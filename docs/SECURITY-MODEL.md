# Security model

Civil 3D MCP is a local bridge into the active Civil 3D process. The native host now treats a running plugin session as a
capability that must be explicitly granted by the user and presented on every RPC. The design narrows accidental and
unauthorized calls; it does not turn arbitrary in-process C# into a sandbox.

## Host session and authorization

- The plugin creates a Windows named pipe restricted to the current Windows user. Its connection descriptor is written
  to `%LOCALAPPDATA%\Civil3DMcp\connections\<pid>.json` and contains `{protocol:1,pid,pipeName,sessionId,token,createdAt}`.
- A client reads the descriptor for the live process and includes `auth: {sessionId, token}` in every JSON-RPC call.
  Missing, malformed, stale, or incorrect credentials are rejected before the command handler runs. A new host session
  rotates its session identifier and token. Revocation keeps the current credentials for Inspect access but invalidates
  queued work authorized under the previous elevated policy; stopping the connection removes the descriptor and ends
  that session.
- The user grants a policy through `C3DMCPAUTHORIZE`: `inspect` permits classified read-only operations, `edit` adds
  typed drawing operations, and `auto` also permits the explicitly trusted arbitrary-code and raw-command features.
  Unknown RPC methods are denied. `getHostSession` is read-only and reports session state without returning the token.
- `C3DMCPREVOKE` returns authorization to the default inspect policy; `C3DMCPSTOP` closes the endpoint and revokes the
  session. Authorization is per host session, not a persistent preference.

The Node HTTP bridge is disabled by default. Enabling it requires an explicit opt-in and a nonempty shared token; each
HTTP request must present that token. Keep it loopback-only unless a deployment has deliberately configured its bind,
host, origin, and token controls.

## Trust boundary and limitations

Arbitrary C# executes inside the Civil 3D process with the Windows user's privileges. Raw AutoCAD commands are also
powerful. They are available only under the explicit `auto` policy, but the feature remains intentionally supported;
this project does not remove C# execution or claim it is sandboxed. A script's read mode uses the existing rollback
model for drawing transactions; rollback does not undo external side effects, file/network activity, process actions,
or arbitrary .NET effects. Treat scripts and commands as trusted code.

The named pipe's current-user restriction authenticates the Windows account, not a particular process. Another process
running as the same user may be able to read user-owned descriptor/token files or otherwise act with that user's
privileges. This protocol is not a defense against malware or a hostile process under the same account. Protect the
Windows account and its local files accordingly.

The policy is an explicit method allowlist maintained alongside the command dispatcher. When adding a plugin method,
classify it deliberately and keep the policy parity tests current. Never infer that a method is safe from its name.

## Local regression checks

`npm run test:host-security` exercises the native policy, request gate, and session credential helpers without loading
Civil 3D or opening a drawing. `npm exec vitest -- run tests/host_session.test.ts` exercises the production Node
connection manager and JSON-RPC client against a temporary named pipe and temporary descriptor. The HTTP bridge
tests cover opt-in and token enforcement. These checks do not read the user's real session files.
