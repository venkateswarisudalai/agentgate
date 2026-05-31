/**
 * mcp-demo — the agentgate "MCP firewall" story, end to end.
 *
 * This script plays the role of an MCP *client* (Claude Desktop, Cursor, Cline…).
 * It spawns mcp-gate, which transparently wraps the fake MCP server:
 *
 *     this driver  <--stdio-->  mcp-gate  <--stdio-->  fake-mcp-server
 *                                  |
 *                                  └── gates tools/call through the control plane
 *
 * The agent (this client) is never modified. Two tool calls are sent:
 *   1. list_users  → read-only → waved through, no approval
 *   2. drop_table  → destructive → FROZEN until a human approves in the dashboard
 *
 * Run the control plane first (`npm run demo`), then `npm run demo:mcp`.
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../.."); // examples/mcp-demo/dist → repo root
const GATE = resolve(repoRoot, "packages/mcp-gate/dist/index.js");
const SERVER = resolve(repoRoot, "examples/fake-mcp-server/dist/index.js");
const GATE_URL = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const AGENT = "mcp-demo-agent";

// --- tiny ANSI helpers (no deps) ---
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const rule = () => console.log(c.dim("─".repeat(64)));

async function preflight(): Promise<void> {
  try {
    const r = await fetch(`${GATE_URL}/healthz`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (err) {
    console.error(c.red(`\n✗ Control plane not reachable at ${GATE_URL}`));
    console.error(c.dim(`  Start it in another terminal first:  npm run demo`));
    console.error(c.dim(`  (${(err as Error).message})\n`));
    process.exit(1);
  }
}

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: any;
  error?: any;
};

async function main() {
  await preflight();

  console.log(c.bold("\n  agentgate — MCP firewall demo"));
  console.log(
    c.dim("  An unmodified MCP client makes two tool calls through mcp-gate.\n"),
  );

  const child = spawn(
    "node",
    [GATE, "--agent", AGENT, "--gate-url", GATE_URL, "--", "node", SERVER],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  const pending = new Map<number, (msg: JsonRpc) => void>();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 1;
  const rpc = (method: string, params?: unknown): Promise<JsonRpc> => {
    const id = nextId++;
    return new Promise((res) => {
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const notify = (method: string, params?: unknown) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  // --- MCP handshake ---
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-demo-driver", version: "0.0.1" },
  });
  notify("notifications/initialized", {});
  const tools = await rpc("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((t: any) => t.name).join(", ");
  console.log(c.dim(`  Wrapped server exposes tools: ${toolNames}\n`));

  // --- Call 1: safe, read-only → should pass straight through ---
  rule();
  console.log(`  ${c.cyan("→ call")} ${c.bold("list_users()")}  ${c.dim("(read-only)")}`);
  const t0 = Date.now();
  const r1 = await rpc("tools/call", { name: "list_users", arguments: {} });
  const dt = Date.now() - t0;
  if (r1.error) {
    console.log(`  ${c.red("✗ blocked")}: ${r1.error.message}`);
  } else {
    console.log(
      `  ${c.green("✓ passed through")} in ${dt}ms — no approval needed ${c.dim("(classifier: low risk)")}`,
    );
    console.log(c.dim(`    ${r1.result?.content?.[0]?.text ?? ""}`));
  }

  // --- Call 2: destructive → should freeze for human approval ---
  rule();
  console.log(`  ${c.cyan("→ call")} ${c.bold('drop_table({ table: "users" })')}  ${c.dim("(destructive)")}`);
  console.log(
    c.yellow(`  ⏸ FROZEN — waiting for a human decision.`),
  );
  console.log(
    `    Approve or deny at ${c.bold(`${GATE_URL}/?tab=agents`)} ${c.dim("(or the Live tab)")}`,
  );
  const r2 = await rpc("tools/call", { name: "drop_table", arguments: { table: "users" } });
  if (r2.error) {
    console.log(`  ${c.red("✗ denied / blocked")} — the destructive call never reached the server.`);
    console.log(c.dim(`    ${r2.error.message}`));
  } else {
    console.log(`  ${c.green("✓ approved")} — call forwarded to the MCP server.`);
    console.log(c.dim(`    ${r2.result?.content?.[0]?.text ?? ""}`));
  }

  rule();
  console.log(
    c.dim(
      `\n  Both calls came from the same unmodified client. The gate decided —\n` +
        `  on the MCP standard, with zero agent code. Every call is in the audit log.\n`,
    ),
  );

  child.kill("SIGINT");
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
