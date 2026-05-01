#!/usr/bin/env node
import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";
import { evaluate, type ToolPayload } from "./rules.js";

type HookInput = ToolPayload & {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
};

const BASE_URL = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const AGENT_NAME = process.env.AGENTGATE_AGENT ?? "claude-code";
const TIMEOUT_MS = parseInt(process.env.AGENTGATE_TIMEOUT_MS ?? "300000", 10);
const FAIL_OPEN = process.env.AGENTGATE_FAIL_OPEN === "1";

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function describeAction(p: HookInput): string {
  const tool = p.tool_name ?? "?";
  const input = p.tool_input ?? {};
  if (tool === "Bash") {
    const cmd = String(input.command ?? "").trim();
    return cmd.length > 240 ? cmd.slice(0, 240) + "…" : cmd;
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return String(input.file_path ?? "?");
  }
  if (tool === "NotebookEdit") return String(input.notebook_path ?? "?");
  return JSON.stringify(input).slice(0, 200);
}

async function main() {
  const raw = await readStdin();
  let payload: HookInput = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stderr.write(`agentgate: malformed hook input — passing through\n`);
    process.exit(0);
  }

  const match = evaluate(payload);
  if (!match) {
    process.exit(0);
  }

  const action = describeAction(payload);
  process.stderr.write(
    `agentgate: ${match.severity.toUpperCase()} risk [${match.category}/${match.ruleId}] — ${match.impact.headline}\n` +
      `agentgate: requesting approval at ${BASE_URL} (timeout ${Math.round(TIMEOUT_MS / 1000)}s)\n`,
  );

  const gate = new AgentGate({
    baseUrl: BASE_URL,
    agent: AGENT_NAME,
    pollIntervalMs: 750,
    defaultTimeoutMs: TIMEOUT_MS,
  });

  try {
    const decision = await gate.requireApproval({
      action: `claude-code.${payload.tool_name ?? "unknown"}`,
      reason: match.impact.headline,
      metadata: {
        ruleId: match.ruleId,
        category: match.category,
        severity: match.severity,
        ruleDescription: match.description,
        impact: match.impact,
        tool: payload.tool_name,
        toolInput: payload.tool_input,
        action,
        sessionId: payload.session_id,
        cwd: payload.cwd,
      },
    });
    if (decision.approved) {
      process.stderr.write(
        `agentgate: ✅ approved by ${decision.decidedBy ?? "unknown"}` +
          (decision.decisionReason ? ` — ${decision.decisionReason}` : "") +
          `\n`,
      );
      process.exit(0);
    } else {
      process.stderr.write(
        `agentgate: 🛑 denied by ${decision.decidedBy ?? "unknown"}` +
          (decision.decisionReason ? ` — ${decision.decisionReason}` : "") +
          `\n`,
      );
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      process.stderr.write(`agentgate: ⏱  approval timed out — blocking for safety\n`);
      process.exit(2);
    }
    if (FAIL_OPEN) {
      process.stderr.write(
        `agentgate: control plane unreachable, AGENTGATE_FAIL_OPEN=1 — allowing\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `agentgate: control plane unreachable (${(err as Error).message}) — blocking for safety. ` +
        `Set AGENTGATE_FAIL_OPEN=1 to allow on outage.\n`,
    );
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`agentgate: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
