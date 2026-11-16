# Security repair preview validation

Version: `2.5.1-security.1`. Base: `d0d60df0f09ce62bd82e97ead37e3e363993894c`.

This fork preserves typed tools, arbitrary C#, raw commands and saved scripts. It changes the authority model:
the native host authenticates a current-user session and enforces locally granted Inspect/Edit/Auto policy.
Auto is trusted in-process automation, not an operating-system sandbox.

## Completed checks

- TypeScript build passed.
- Full Windows Vitest suite: **631 passed, 0 failed, 3 skipped** out of 634 cases.
  The skipped cases compare three shared-contract fixtures with a separate sibling repository when present;
  that repository was absent. No security regression was skipped for lack of a running application.
- Native host-security harness passed: valid/missing/wrong/stale credentials, no handler invocation on denial,
  Inspect/Edit/Auto permissions, revocation generation, method-table parity, and representative engineering reads.
- Existing filesystem/transport harness passed after migration to named pipes: path boundaries, disconnect
  cancellation, response completion, invalid UTF-8, bounded jobs and the existing engineering checks.
- A production Node client reached an inert named-pipe host using a temporary discovery descriptor and authenticated envelope.
- A real stdio MCP server initialized while its HTTP port remained closed with HTTP opt-in absent.
- HTTP tests enforce mandatory authentication, preserve Host/Origin checks and reject oversized requests.
- Native plugin compiled against the installed Civil 3D 2027 references with **0 errors and 2 existing warnings**
  in `SurveyCom.cs` and `SuperelevationCommands.cs`.
- Generated tool reference remains current at 207 catalog entries; startup reports 209 captured handlers.
- Version synchronization, source/binary digest checks and package inspection passed.
- Complete preview ZIP and MCP bundle packaging passed the privacy and Autodesk-DLL exclusion gates.

The checked-in `prebuilt/Civil3DMcpPlugin/BUILD-INFO.json` records the normalized native source hash and SHA-256
digests for every generated payload file. The plugin was rebuilt from this fork's source. These build records are
not an independent reproducible-build attestation or a publisher signature.

## Audit disposition

- Unauthenticated native TCP route: removed; production discovery uses an authenticated current-user named pipe.
- Anonymous HTTP/self-issued authority: HTTP is opt-in and authenticated. Caller-issued compatibility tokens cannot
  grant native authority. Auto sessions work without per-call token prompts; Node-owned mutations require a live grant.
- Misleading read-only C# boundary: arbitrary code, including model-rollback queries, requires Auto and is marked
  privileged. Model rollback still does not undo external side effects. The underlying code-filter bypass is not
  claimed to be a secure sandbox fix.
- Prebuilt provenance: rebuilt locally from reviewed source and payload digests recorded/checked before packaging.

## Remaining deployment gate

**Ready for a controlled disposable-drawing pilot; not production-certified.** No plugin was installed, no Civil 3D
process was launched and no real project model was used during implementation. Native UI prompts, actual document
switching, model changes, undo and application restart must still be exercised in Civil 3D before project deployment.
The preview package is unsigned. Other processes running as the same Windows user remain within the trust boundary.

An independent review found two integration issues that were corrected before the final run: incomplete Inspect
classification of typed calculations, and stale descriptors blocking live-instance selection after a crash.
