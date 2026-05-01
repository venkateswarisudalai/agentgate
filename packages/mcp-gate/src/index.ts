#!/usr/bin/env node
/**
 * agentgate-mcp-gate — wraps any MCP server (stdio transport).
 *
 * Architecture:
 *   MCP client (Claude Desktop, Cursor, Cline, ...) <--stdio--> mcp-gate <--stdio--> wrapped MCP server
 *
 * mcp-gate forwards everything transparently EXCEPT `tools/call` requests,
 * which it intercepts: classify risk → request approval from agentgate
 * control plane → forward (or return error) accordingly.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
type WrappedProc = ChildProcessByStdio<Writable, Readable, null>;
import * as readline from "node:readline";
import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";
import { classify } from "./heuristics.js";

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

function usage(exit = 0): never {
  process.stderr.write(`agentgate-mcp-gate — wrap an MCP server with HITL approval

Usage:
  agentgate-mcp-gate --agent <name> -- <wrapped-server-command> [args...]

Required:
  --agent <name>       agent identity recorded in the audit log

Options:
  --gate-url <url>     control plane URL (default $AGENTGATE_URL or http://localhost:4000)
  --allow <list>       comma-separated tool names to always allow (no approval)
  --deny  <list>       comma-separated tool names to always deny
  --gate-all           require approval for every tools/call (override heuristics)
  --timeout-ms <n>     approval timeout (default 300000 = 5 min)

Example:
  agentgate-mcp-gate --agent stripe-mcp -- npx -y @stripe/mcp
`);
  process.exit(exit);
}

type Cfg = {
  agent: string;
  gateUrl: string;
  allow: Set<string>;
  deny: Set<string>;
  gateAll: boolean;
  timeoutMs: number;
  cmd: string;
  args: string[];
};

function parseArgs(argv: string[]): Cfg {
  const sep = argv.indexOf("--");
  if (sep < 0) usage(1);
  const flags = argv.slice(0, sep);
  const rest = argv.slice(sep + 1);
  if (rest.length === 0) usage(1);

  const get = (k: string): string | undefined => {
    const i = flags.indexOf(k);
    if (i < 0) return undefined;
    return flags[i + 1];
  };
  const has = (k: string) => flags.includes(k);

  const agent = get("--agent");
  if (!agent) usage(1);

  return {
    agent: agent!,
    gateUrl: get("--gate-url") ?? process.env.AGENTGATE_URL ?? "http://localhost:4000",
    allow: new Set((get("--allow") ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    deny: new Set((get("--deny") ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    gateAll: has("--gate-all"),
    timeoutMs: parseInt(get("--timeout-ms") ?? "300000", 10),
    cmd: rest[0],
    args: rest.slice(1),
  };
}

const log = (msg: string) => process.stderr.write(`[mcp-gate] ${msg}\n`);

function send(stream: NodeJS.WritableStream, msg: JsonRpc): void {
  stream.write(JSON.stringify(msg) + "\n");
}

function jsonRpcError(id: number | string | undefined, code: number, message: string, data?: unknown): JsonRpc {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  log(`wrapping: ${cfg.cmd} ${cfg.args.join(" ")}`);
  log(`agent=${cfg.agent} gate=${cfg.gateUrl}`);

  const gate = new AgentGate({
    baseUrl: cfg.gateUrl,
    agent: cfg.agent,
    pollIntervalMs: 750,
    defaultTimeoutMs: cfg.timeoutMs,
  });

  const child = spawn(cfg.cmd, cfg.args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("exit", (code, signal) => {
    log(`wrapped server exited (code=${code} signal=${signal})`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    log(`failed to spawn wrapped server: ${err.message}`);
    process.exit(1);
  });

  // Track in-flight tools/call requests so when the wrapped server replies we
  // can pass the response back. (Most messages are forwarded as-is; only
  // tools/call needs the gate-then-forward dance.)
  const clientToWrapped = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const wrappedToClient = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  // From client → either gate (if tools/call) or forward to wrapped server.
  clientToWrapped.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: JsonRpc;
    try { msg = JSON.parse(line); } catch { send(child.stdin, { jsonrpc: "2.0", id: undefined } as JsonRpc); return; }

    if (msg.method === "tools/call") {
      handleToolsCall(msg, child, gate, cfg).catch((err) => {
        log(`gate error: ${(err as Error).message}`);
        send(process.stdout, jsonRpcError(msg.id, -32000, `agentgate: ${(err as Error).message}`));
      });
      return;
    }

    // Pass through anything else.
    send(child.stdin, msg);
  });

  // From wrapped server → forward to client.
  wrappedToClient.on("line", (line) => {
    if (!line.trim()) return;
    process.stdout.write(line + "\n");
  });

  process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(130); });
  process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(143); });
}

async function handleToolsCall(
  msg: JsonRpc,
  child: WrappedProc,
  gate: AgentGate,
  cfg: Cfg,
): Promise<void> {
  const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const toolName = params.name ?? "(unknown)";
  const args = params.arguments ?? {};

  // Static allow / deny.
  if (cfg.allow.has(toolName)) {
    log(`allow-listed: ${toolName} → forwarding without approval`);
    send(child.stdin, msg);
    return;
  }
  if (cfg.deny.has(toolName)) {
    log(`deny-listed: ${toolName} → returning error`);
    send(process.stdout, jsonRpcError(msg.id, -32001, `agentgate: tool '${toolName}' is deny-listed`));
    return;
  }

  // Classify risk.
  const decision = classify(toolName, args);
  if (!cfg.gateAll && decision.risk === "low") {
    // Heuristic says safe — pass through silently.
    send(child.stdin, msg);
    return;
  }

  log(`gating tool '${toolName}' (risk=${decision.risk}) — ${decision.reasons.join("; ") || "policy: gate-all"}`);

  let approved = false;
  let decidedBy = "unknown";
  let decisionReason: string | null = null;
  try {
    const result = await gate.requireApproval({
      action: `mcp.${toolName}`,
      reason: decision.headline,
      metadata: {
        ruleId: `mcp-${decision.risk}`,
        category: "mcp",
        severity: decision.risk,
        impact: {
          headline: decision.headline,
          consequences: [...decision.consequences, ...decision.reasons.map((r) => `signal: ${r}`)],
          recoverable: decision.recoverable,
          targets: { tool: toolName },
        },
        tool: "MCP",
        toolInput: { command: `mcp::${toolName}(${JSON.stringify(args)})`, name: toolName, arguments: args },
        action: `${toolName}(${JSON.stringify(args).slice(0, 120)})`,
      },
    });
    approved = result.approved;
    decidedBy = result.decidedBy ?? "unknown";
    decisionReason = result.decisionReason;
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      log(`approval timed out for ${toolName} → blocking`);
      send(process.stdout, jsonRpcError(msg.id, -32002, `agentgate: approval timed out — call blocked for safety`));
      return;
    }
    throw err;
  }

  if (approved) {
    log(`approved by ${decidedBy} → forwarding ${toolName}`);
    send(child.stdin, msg);
  } else {
    log(`denied by ${decidedBy}${decisionReason ? ` (${decisionReason})` : ""} → returning error`);
    send(process.stdout, jsonRpcError(msg.id, -32001, `agentgate: denied by ${decidedBy}${decisionReason ? ` — ${decisionReason}` : ""}`));
  }
}

main().catch((err) => {
  process.stderr.write(`[mcp-gate] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
