#!/usr/bin/env node
import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";
import { scanMany, type ScanResult, type Risk } from "@agentgate/pkg-scan";
import { evaluate, type ToolPayload } from "./rules.js";
import { detectInstall, type InstallIntent } from "./install-detector.js";

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

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function aggregateRisk(results: ScanResult[]): Risk {
  let max: Risk = "low";
  for (const r of results) if (RISK_RANK[r.risk] > RISK_RANK[max]) max = r.risk;
  return max;
}

function summarizeScan(r: ScanResult): string {
  const top = r.signals
    .filter((s) => s.severity === "critical" || s.severity === "high")
    .slice(0, 3)
    .map((s) => `${s.severity}:${s.kind}:${s.message}`)
    .join(" | ");
  return `${r.ecosystem}:${r.name}@${r.version} risk=${r.risk}${top ? " — " + top : ""}`;
}

async function handleInstallIntent(
  intent: InstallIntent,
  payload: HookInput,
): Promise<void> {
  process.stderr.write(
    `agentgate: detected ${intent.manager} install of ${intent.packages.length} ` +
      `package(s): ${intent.packages.map((p) => p.name).join(", ")}\n` +
      `agentgate: scanning supply chain...\n`,
  );

  let results: ScanResult[] = [];
  try {
    results = await scanMany(
      intent.packages.map((p) => ({
        ecosystem: intent.ecosystem,
        name: p.name,
        version: p.version,
      })),
    );
  } catch (err) {
    process.stderr.write(
      `agentgate: scan failed (${(err as Error).message}) — falling back to generic gating\n`,
    );
    return;
  }

  const overall = aggregateRisk(results);
  for (const r of results) process.stderr.write(`agentgate: ${summarizeScan(r)}\n`);

  // Auto-allow obvious low-risk installs without bothering the user.
  if (overall === "low") {
    process.stderr.write(`agentgate: ✅ all packages low-risk — allowing\n`);
    process.exit(0);
  }

  process.stderr.write(
    `agentgate: overall risk=${overall.toUpperCase()} — requesting approval at ${BASE_URL}\n`,
  );

  const gate = new AgentGate({
    baseUrl: BASE_URL,
    agent: AGENT_NAME,
    pollIntervalMs: 750,
    defaultTimeoutMs: TIMEOUT_MS,
  });

  try {
    const decision = await gate.requireApproval({
      action: `pkg.install.${intent.ecosystem}`,
      reason:
        `${intent.manager} install: ${intent.packages.map((p) => p.name).join(", ")} — risk ${overall}`,
      metadata: {
        manager: intent.manager,
        ecosystem: intent.ecosystem,
        packages: intent.packages,
        risk: overall,
        scan: results,
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

async function main() {
  const raw = await readStdin();
  let payload: HookInput = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stderr.write(`agentgate: malformed hook input — passing through\n`);
    process.exit(0);
  }

  // Package install: scanner-rich path before generic Bash rules.
  if (payload.tool_name === "Bash") {
    const cmd = String((payload.tool_input ?? {}).command ?? "");
    const intent = detectInstall(cmd);
    if (intent) {
      await handleInstallIntent(intent, payload);
      return; // handler always exits
    }
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
