// Minimal MCP-like stdio JSON-RPC server for demo purposes.
// Implements just enough of the MCP wire protocol that mcp-gate can wrap it
// and we can exercise the tools/call interception path end-to-end.
import * as readline from "node:readline";

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };

const TOOLS = [
  { name: "list_users", description: "List active users", inputSchema: { type: "object", properties: {} } },
  { name: "get_user", description: "Get a user by id", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "delete_user", description: "Delete a user by id", inputSchema: { type: "object", properties: { id: { type: "string" }, force: { type: "boolean" } } } },
  { name: "drop_table", description: "Drop a database table", inputSchema: { type: "object", properties: { table: { type: "string" } } } },
];

const send = (msg: JsonRpc) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: JsonRpc;
  try { req = JSON.parse(line); } catch { return; }

  switch (req.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } } });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
      break;
    case "tools/call": {
      const { name, arguments: args } = req.params ?? {};
      // Pretend to do the thing.
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `(fake) ${name} executed with ${JSON.stringify(args ?? {})}` }] } });
      break;
    }
    case "notifications/initialized":
      // no response for notifications
      break;
    default:
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});

process.stderr.write("[fake-mcp-server] ready on stdio\n");
