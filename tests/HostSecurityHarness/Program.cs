// Package-free regression harness for native host-session policy and authorization primitives.
using Civil3DMcpPlugin;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

static void Check(bool condition, string message)
{
  if (!condition) throw new InvalidOperationException(message);
}

HostSessionPolicy.Reset();
Check(HostSessionPolicy.Current == HostPolicy.Inspect, "Policy must default to inspect.");
Check(HostSessionPolicy.IsKnown("getDrawingInfo"), "A read method must be classified.");
Check(HostSessionPolicy.IsKnown("getHostSession") && HostSessionPolicy.Allows("getHostSession"),
  "Host session inspection must remain available under the default policy.");
Check(!HostSessionPolicy.IsKnown("unknownMethod"), "Unknown methods must not be classified.");
Check(HostSessionPolicy.Allows("getDrawingInfo"), "Inspect must allow classified reads.");
foreach (var method in new[] { "transformCoordinates", "alignmentStationToPoint", "alignmentGetStationOffset",
  "sampleProfileElevations", "cogoInverse", "calculateSightDistance", "calculateSurfaceVolumeByRegion",
  "qtySurfaceVolume", "calculateTimeOfConcentration", "exportPressureNetwork", "drawingReadinessAuditWorkflow" })
  Check(HostSessionPolicy.Allows(method), $"Inspect must allow read-only engineering operation {method}.");
foreach (var method in new[] { "reportParcels", "generateSuperelevationReport", "calculateMaterialCostEstimate",
  "corridorQcReportWorkflow", "qtyExportToCsv", "exportSectionData", "createPolyline" })
  Check(!HostSessionPolicy.Allows(method), $"Inspect must deny writing or mixed operation {method}.");
Check(!HostSessionPolicy.Allows("createPolyline"), "Inspect must deny typed writes.");
Check(!HostSessionPolicy.Allows("executeCode"), "Inspect must deny arbitrary C#.");
Check(!HostSessionPolicy.Allows("runAcadCommand"), "Inspect must deny raw commands.");
Check(!HostSessionPolicy.Allows("unknownMethod"), "Every policy must deny unknown methods.");

HostSessionPolicy.Set(HostPolicy.Edit);
Check(HostSessionPolicy.Allows("getDrawingInfo"), "Edit must retain inspect access.");
Check(HostSessionPolicy.Allows("createPolyline"), "Edit must allow typed writes.");
Check(!HostSessionPolicy.Allows("executeCode"), "Edit must deny arbitrary C#.");
Check(!HostSessionPolicy.Allows("runAcadCommand"), "Edit must deny raw commands.");

HostSessionPolicy.Set(HostPolicy.Auto);
Check(HostSessionPolicy.Allows("createPolyline"), "Auto must allow typed writes.");
Check(HostSessionPolicy.Allows("executeCode"), "Auto must allow trusted arbitrary C#.");
Check(HostSessionPolicy.Allows("queryCode"), "Auto must allow trusted code inspection.");
Check(HostSessionPolicy.Allows("runAcadCommand"), "Auto must allow trusted raw commands.");

HostSessionPolicy.Reset();
Check(HostSessionPolicy.Current == HostPolicy.Inspect, "Revocation must restore inspect policy.");
Check(!HostSessionPolicy.Allows("createPolyline"), "Revocation must remove write access.");
Check(!HostSessionPolicy.Allows("executeCode"), "Revocation must remove trusted-code access.");

var firstSession = new HostSessionDescriptor();
var validAuth = new JsonObject { ["sessionId"] = firstSession.SessionId, ["token"] = firstSession.Token };
Check(firstSession.Authenticate(validAuth), "Current session credentials must authenticate.");
Check(!firstSession.Authenticate(null), "Missing credentials must fail authentication.");
Check(!firstSession.Authenticate(new JsonObject { ["sessionId"] = firstSession.SessionId, ["token"] = "wrong" }),
  "Incorrect credentials must fail authentication.");
Check(!firstSession.Authenticate(new JsonObject { ["sessionId"] = "stale", ["token"] = firstSession.Token }),
  "A stale session identifier must fail authentication.");
var rotatedSession = new HostSessionDescriptor();
Check(rotatedSession.SessionId != firstSession.SessionId && rotatedSession.Token != firstSession.Token,
  "A new host session must rotate its identifier and token.");
Check(!rotatedSession.Authenticate(validAuth), "Credentials from an earlier host session must fail after rotation.");

var handlerCalls = 0;
Task<string> Handler()
{
  handlerCalls++;
  return Task.FromResult("handled");
}

async Task MustReject(JsonNode? auth, HostSessionDescriptor? session, string method, string code)
{
  try
  {
    await HostSessionRequestGate.ExecuteAsync(session, auth, method, Handler);
    throw new InvalidOperationException($"Expected {code} for {method}.");
  }
  catch (HostSessionGateException exception) when (exception.Code == code) { }
}

await MustReject(null, firstSession, "getDrawingInfo", "CIVIL3D.AUTH_REQUIRED");
await MustReject(new JsonObject { ["sessionId"] = firstSession.SessionId, ["token"] = "bad" }, firstSession, "getDrawingInfo", "CIVIL3D.AUTH_REQUIRED");
await MustReject(validAuth, rotatedSession, "getDrawingInfo", "CIVIL3D.AUTH_REQUIRED");
Check(handlerCalls == 0, "Requests with missing, invalid, or stale credentials must never invoke a handler.");

var handled = await HostSessionRequestGate.ExecuteAsync(firstSession, validAuth, "getDrawingInfo", Handler);
Check(handled == "handled" && handlerCalls == 1, "Correct credentials must reach the handler.");
await MustReject(validAuth, firstSession, "createPolyline", "CIVIL3D.FORBIDDEN");
Check(handlerCalls == 1, "Inspect policy must stop a typed write before its handler.");
HostSessionPolicy.Set(HostPolicy.Edit);
await HostSessionRequestGate.ExecuteAsync(firstSession, validAuth, "createPolyline", Handler);
Check(handlerCalls == 2, "Edit policy must reach a typed-write handler.");
HostSessionPolicy.Reset();
await MustReject(validAuth, firstSession, "createPolyline", "CIVIL3D.FORBIDDEN");
Check(handlerCalls == 2, "Revocation must deny later typed writes before their handler.");
HostSessionPolicy.Set(HostPolicy.Auto);
await HostSessionRequestGate.ExecuteAsync(firstSession, validAuth, "executeCode", Handler);
await HostSessionRequestGate.ExecuteAsync(firstSession, validAuth, "runAcadCommand", Handler);
Check(handlerCalls == 4, "Auto policy must reach trusted code and raw-command handlers.");
var queuedRevision = HostSessionPolicy.Revision;
HostSessionPolicy.Reset();
HostSessionPolicy.Set(HostPolicy.Auto);
Check(!HostSessionPolicy.AllowsAtRevision("executeCode", queuedRevision),
  "Revoking and regranting Auto must not restore authority to work queued under an earlier grant.");
Check(HostSessionPolicy.Allows("executeCode"), "The current Auto grant must authorize new requests.");
HostSessionPolicy.Reset();

var repoRoot = Directory.GetCurrentDirectory();
var policySource = await File.ReadAllTextAsync(Path.Combine(repoRoot, "Civil3D-MCP-Plugin", "HostSessionPolicy.cs"));
var knownBody = Regex.Match(policySource, @"private static readonly HashSet<string> Known = new\(StringComparer.Ordinal\) \{(?<body>.*?)\};", RegexOptions.Singleline);
Check(knownBody.Success, "Could not read the native policy method allowlist.");
var allowedMethods = Regex.Matches(knownBody.Groups["body"].Value, "\\\"([^\\\"]+)\\\"")
  .Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
allowedMethods.Add("getHostSession");
var dispatcherSource = await File.ReadAllTextAsync(Path.Combine(repoRoot, "Civil3D-MCP-Plugin", "CommandDispatcher.cs"));
var dispatchMethods = Regex.Matches(dispatcherSource, "^\\s*\\\"([^\\\"]+)\\\"\\s*=>", RegexOptions.Multiline)
  .Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
Check(allowedMethods.SetEquals(dispatchMethods), "Native authorization methods must match the dispatcher method table exactly.");

Console.WriteLine("Host security policy and session credential checks passed.");
