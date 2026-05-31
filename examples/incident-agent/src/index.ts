/**
 * incident-agent — an AI DevOps engineer, gated by agentgate.
 *
 * A standalone autonomous agent (NOT a Claude Code persona). It runs its own
 * loop, reasons with the Claude API directly, and gates every risky action
 * through agentgate:
 *   WATCH logs → DETECT a fault → DIAGNOSE → PROPOSE → ASK a human → ACT → audit
 *
 * Modes:
 *   (default)  triage one incident, then exit — good for a demo.
 *   --watch    run forever: keep monitoring, handle each incident as it arises.
 *
 * Diagnosis is real when ANTHROPIC_API_KEY is set (Claude reasons over the logs
 * + deploy history); otherwise it falls back to a deterministic heuristic so the
 * demo always runs. See diagnose.ts.
 *
 * Run the control plane first (`npm run demo`), then `npm run demo:incident`
 * (one-shot) or `node dist/index.js --watch` (autonomous).
 */
import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";
import { diagnose, type IncidentInput } from "./diagnose.js";

const GATE_URL = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const SERVICE = "orders-api";
const AGENT = "incident-agent";
const WATCH = process.argv.includes("--watch");
const BASELINE = 0.01;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rule = () => console.log(c.dim("─".repeat(66)));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ----- synthetic service: emits a request log; a bad deploy spikes 5xx -----
type ReqLog = { status: number; route: string };

class OrdersApi {
  private major = 42;
  version = "v42";
  lastGood = "v42";
  errorRate = BASELINE;
  deployedAt: number | null = null;

  tick(): ReqLog {
    const status = Math.random() < this.errorRate ? 500 : 200;
    return { status, route: "/api/orders" };
  }
  deployBad(now: number): void {
    this.lastGood = this.version;
    this.major += 1;
    this.version = `v${this.major}`;
    this.deployedAt = now;
    this.errorRate = 0.32 + Math.random() * 0.08;
    console.log(`  ${c.blue("⎈ deploy")}  ${SERVICE} ${c.bold(`${this.lastGood} → ${this.version}`)} ${c.dim("(rollout complete)")}`);
  }
  rollback(): void {
    this.version = this.lastGood;
    this.errorRate = BASELINE;
    this.deployedAt = null;
  }
}

class Detector {
  private window: number[] = [];
  constructor(private size = 25, private threshold = 0.15) {}
  observe(status: number): void {
    this.window.push(status >= 500 ? 1 : 0);
    if (this.window.length > this.size) this.window.shift();
  }
  get rate(): number {
    return this.window.length ? this.window.reduce((a, b) => a + b, 0) / this.window.length : 0;
  }
  firing(): boolean {
    return this.window.length >= this.size && this.rate >= this.threshold;
  }
}

const gate = new AgentGate({ baseUrl: GATE_URL, agent: AGENT, pollIntervalMs: 750, defaultTimeoutMs: 300000 });

// Diagnose → gate → act for one detected incident. Returns the outcome.
async function handleIncident(
  svc: OrdersApi,
  det: Detector,
  logBuffer: string[],
  label: string,
): Promise<"resolved" | "denied" | "timeout"> {
  console.log("");
  console.log(`  ${c.red(`⚠ ANOMALY ${label}`)}  ${SERVICE} 5xx ${c.bold(pct(det.rate))} over last 25 requests`);
  rule();

  const input: IncidentInput = {
    service: SERVICE,
    currentVersion: svc.version,
    errorRate: det.rate,
    baselineRate: BASELINE,
    deployVersion: svc.version,
    secondsSinceDeploy: svc.deployedAt ? Math.round((Date.now() - svc.deployedAt) / 1000) : null,
    recentLogs: logBuffer,
  };
  console.log(c.dim(`  🤔 diagnosing…`));
  const dx = await diagnose(input);
  const via = dx.source === "claude" ? c.dim("(via Claude)") : c.dim("(heuristic)");
  console.log(`  ${c.cyan("🔎 root cause")}  ${dx.rootCause} ${via}`);
  console.log(`  ${c.cyan("🛠 remediation")} ${c.bold(dx.remediation)} ${c.dim(`· confidence ${dx.confidence}`)}`);
  console.log(`  ${c.cyan("↩ rollback")}    ${dx.rollbackPlan}`);
  console.log("");
  console.log(`  ${c.yellow("⏸ requesting approval")} — the agent will NOT act until a human says so.`);
  console.log(`    Approve or deny at ${c.bold(`${GATE_URL}/?tab=agents`)}`);

  let approved = false, decidedBy = "unknown", reason: string | null = null;
  try {
    const d = await gate.requireApproval({
      action: "k8s.rollback",
      reason: `${SERVICE} 5xx at ${pct(det.rate)} — ${dx.remediation}`,
      metadata: {
        ruleId: "incident-rollback", category: "incident-response", severity: "high",
        impact: {
          headline: `${SERVICE} 5xx at ${pct(det.rate)} (baseline ~${pct(BASELINE)})`,
          consequences: [
            `Root cause: ${dx.rootCause}`,
            `Remediation: ${dx.remediation}`,
            `Rollback plan: ${dx.rollbackPlan}`,
            `Confidence: ${dx.confidence} · diagnosis via ${dx.source}`,
          ],
          recoverable: "yes",
          targets: { service: SERVICE, version: svc.version },
        },
        tool: "kubectl",
        toolInput: { command: `kubectl rollout undo deploy/${SERVICE}` },
        action: `rollback ${SERVICE} ${svc.version}→${svc.lastGood}`,
      },
    });
    approved = d.approved; decidedBy = d.decidedBy ?? "unknown"; reason = d.decisionReason;
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      console.log(`\n  ${c.yellow("⏱ approval timed out")} — incident stays open, paging on-call.`);
      return "timeout";
    }
    throw err;
  }

  console.log("");
  rule();
  if (!approved) {
    console.log(`  ${c.red("✗ denied")} by ${decidedBy}${reason ? c.dim(` — ${reason}`) : ""}`);
    console.log(c.dim(`  Agent stands down. Incident remains open; escalating to on-call.`));
    return "denied";
  }
  console.log(`  ${c.green("✓ approved")} by ${decidedBy}${reason ? c.dim(` — ${reason}`) : ""}`);
  process.stdout.write(`  ${c.cyan("executing")} ${c.dim(`kubectl rollout undo deploy/${SERVICE} …`)}`);
  await wait(600);
  svc.rollback();
  console.log(c.green("  done"));
  console.log(c.dim(`  verifying recovery… ${SERVICE} ${svc.version} 5xx=${pct(BASELINE)} ✓`));
  return "resolved";
}

// Tick the service, feed the detector + log buffer, print a periodic health line.
function step(svc: OrdersApi, det: Detector, logBuffer: string[], i: number, heartbeat: boolean): void {
  const log = svc.tick();
  det.observe(log.status);
  logBuffer.push(`${SERVICE} ${svc.version} ${log.route} -> ${log.status}`);
  if (logBuffer.length > 60) logBuffer.shift();
  if (heartbeat) {
    const r = det.rate;
    const color = r >= 0.15 ? c.red : r >= 0.05 ? c.yellow : c.green;
    console.log(`  ${c.dim(`#${String(i).padStart(3)}`)}  ${SERVICE} ${svc.version}  5xx=${color(pct(r))}`);
  }
}

async function preflight(): Promise<void> {
  try {
    const r = await fetch(`${GATE_URL}/healthz`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (err) {
    console.error(c.red(`\n✗ Control plane not reachable at ${GATE_URL}`));
    console.error(c.dim(`  Start it first:  npm run demo   (${(err as Error).message})\n`));
    process.exit(1);
  }
}

function banner(): void {
  const brain = process.env.ANTHROPIC_API_KEY ? "Claude-powered" : "heuristic (set ANTHROPIC_API_KEY for Claude)";
  console.log(c.bold(`\n  🤖 incident-agent — an AI DevOps engineer (gated by agentgate)`));
  console.log(c.dim(`  ${WATCH ? "Autonomous watch mode" : "One-shot triage"} · diagnosis: ${brain}`));
  console.log(c.dim(`  Read-only by default — it won't change anything without human approval.\n`));
  rule();
}

async function main() {
  await preflight();
  banner();
  const svc = new OrdersApi();

  if (!WATCH) {
    const det = new Detector();
    const logBuffer: string[] = [];
    for (let i = 0; i < 200; i++) {
      step(svc, det, logBuffer, i, i % 10 === 0);
      if (i === 44) svc.deployBad(Date.now());
      if (det.firing()) break;
      await wait(90);
    }
    await handleIncident(svc, det, logBuffer, "");
    rule();
    console.log(c.dim(`\n  Detected, diagnosed, and fixed — but a human approved the one risky\n  step, and every action is in the audit log. (Run with --watch to stay on.)\n`));
    process.exit(0);
  }

  // --watch: autonomous, forever
  let incident = 0;
  const logBuffer: string[] = [];
  console.log(c.green(`  ● live — monitoring ${SERVICE} continuously. Ctrl-C to stop.\n`));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // healthy stretch
    const det = new Detector();
    for (let i = 0; i < 28; i++) {
      step(svc, det, logBuffer, i, i % 14 === 0);
      await wait(80);
    }
    // a bad deploy lands → incident
    incident += 1;
    svc.deployBad(Date.now());
    while (!det.firing()) {
      step(svc, det, logBuffer, 99, false);
      await wait(70);
    }
    await handleIncident(svc, det, logBuffer, `#${incident}`);
    rule();
    console.log(c.green(`  ● resolved — back to monitoring.\n`));
    await wait(1500);
  }
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
