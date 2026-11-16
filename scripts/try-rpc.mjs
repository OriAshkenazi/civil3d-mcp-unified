// Sends one authenticated JSON-RPC request straight to the plugin's named pipe.
// Usage: node scripts/try-rpc.mjs <method> ['<json params>']
// A developer's debugging aid, run by hand only. It uses production discovery/authentication and the plugin's
// Inspect/Edit/Auto policy. It cannot grant privileges; the user does that locally in Civil 3D.
// Use read methods unless the drawing is disposable. Prints the first complete JSON response, then closes.
import { withApplicationConnection } from "../build/utils/ConnectionManager.js";

const [method, params = "{}"] = process.argv.slice(2);
if (!method) {
  console.error("Usage: node scripts/try-rpc.mjs <method> ['<json params>']");
  process.exit(2);
}

try {
  const result = await withApplicationConnection((client) => client.sendCommand(method, JSON.parse(params)));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
