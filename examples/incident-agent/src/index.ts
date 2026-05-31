/**
 * incident-agent — an AI DevOps engineer, gated by agentgate.
 *
 * The loop a real SRE runs, automated:
 *   WATCH logs  →  DETECT a fault  →  DIAGNOSE root cause  →
 *   PROPOSE a remediation  →  ASK a human (agentgate)  →  ACT  →  audit
 *
 * For a self-contained demo it watches a synthetic `orders-api` log stream: a
 * deploy lands, the 5xx rate spikes, the agent correlates the spike with the
 * deploy, proposes a rollback, and routes that rollback through the agentgate
 * control plane for human approval before it touches anything.
 *
 * The detection + diagnosis here are deterministic so the demo always works;
 * `diagnose()` is the seam where a real LLM call (Claude) would slot in.
 *
 * Run the control plane first (`npm run demo`), then `npm run demo:incident`.
 */
import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";

const GATE_URL = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const SERVICE = "orders-api";
const AGENT = "incident-agent";

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

// ----- synthetic service: a log stream with a bad deploy partway through -----
type ReqLog = { t: number; status: number; route: string };

class OrdersApi {
  version = "v42";
  errorRate = 0.01; // healthy baseline
  private n = 0;
  deployedAt: number | null = null;

  tick(now: number): ReqLog {
    this.n++;
    // A bad deploy lands at request ~45 and pushes the 5xx rate way up.
    if (this.n === 45) {
      this.version = "v43";
      this.deployedAt = now;
      this.errorRate = 0.34;
      console.log(
        `  ${c.blue("⎈ deploy")}  ${SERVICE} ${c.bold("v42 → v43")} ${c.dim("(rollout complete)")}`,
      );
    }
    const status = Math.random() < this.errorRate ? 500 : 200;
    return { t: now, status, route: "/api/orders" };
  }

  rollback(): void {
    this.version = "v42";
    this.errorRate = 0.01;
  }
}

// ----- detector: error rate over a sliding window -----
class Detector {
  private window: number[] = [];
  constructor(private size = 25, private threshold = 0.15) {}
  observe(status: number): void {
    this.window.push(status >= 500 ? 1 : 0);
    if (this.window.length > this.size) this.window.shift();
  }
  get rate(): number {
    if (!this.window.length) return 0;
    return this.window.reduce((a, b) => a + b, 0) / this.window.length;
  }
  get full(): boolean {
    return this.window.length >= this.size;
  }
  firing(): boolean {
    return this.full && this.rate >= this.threshold;
  }
}

type Diagnosis = {
  headline: string;
  rootCause: string;
  remediation: string;
  fromVersion: string;
  toVersion: string;
  confidence: "high" | "medium" | "low";
};

// The "AI" step. Deterministic here; swap for an LLM over the log buffer + deploy
// history to make it genuinely reason. The shape it returns stays the same.
function diagnose(svc: OrdersApi, rate: number, now: number): Diagnosis {
  const sinceDeploy = svc.deployedAt ? Math.round((now - svc.deployedAt) / 1000) : null;
  const deployCorrelated = sinceDeploy !== null && sinceDeploy < 120;
  return {
    headline: `${SERVICE} 5xx rate at ${pct(rate)} (baseline ~1%)`,
    rootCause: deployCorrelated
      ? `error spike began ~${sinceDeploy}s after deploy ${svc.version} — almost certainly a bad deploy`
      : `error spike with no recent deploy — needs deeper investigation`,
    remediation: `roll back ${SERVICE} ${svc.version} → v42`,
    fromVersion: svc.version,
    toVersion: "v42",
    confidence: deployCorrelated ? "high" : "low",
  };
}

async function main() {
  // preflight
  try {
    const r = await fetch(`${GATE_URL}/healthz`);
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (err) {
    console.error(c.red(`\n✗ Control plane not reachable at ${GATE_URL}`));
    console.error(c.dim(`  Start it first:  npm run demo   (${(err as Error).message})\n`));
    process.exit(1);
  }

  console.log(c.bold(`\n  🤖 incident-agent — an AI DevOps engineer (gated by agentgate)`));
  console.log(c.dim(`  Watching ${SERVICE} logs. Read-only — it won't touch anything without asking.\n`));
  rule();

  const svc = new OrdersApi();
  const det = new Detector();
  const gate = new AgentGate({ baseUrl: GATE_URL, agent: AGENT, pollIntervalMs: 750, defaultTimeoutMs: 300000 });

  let lastPrinted = -1;
  // WATCH + DETECT
  for (let i = 0; i < 200; i++) {
    const now = Date.now();
    const log = svc.tick(now);
    det.observe(log.status);

    // surface a periodic health line (and every error once the spike starts)
    if (i % 10 === 0 || (log.status >= 500 && det.rate > 0.1)) {
      const r = det.rate;
      const color = r >= 0.15 ? c.red : r >= 0.05 ? c.yellow : c.green;
      if (i !== lastPrinted) {
        console.log(`  ${c.dim(`req#${String(i).padStart(3)}`)}  ${SERVICE} ${svc.version}  5xx=${color(pct(r))}`);
        lastPrinted = i;
      }
    }

    if (det.firing()) {
      console.log("");
      console.log(`  ${c.red("⚠ ANOMALY")}  ${SERVICE} 5xx rate ${c.bold(pct(det.rate))} over last ${25} requests`);
      break;
    }
    await wait(90);
  }

  // DIAGNOSE
  rule();
  const dx = diagnose(svc, det.rate, Date.now());
  console.log(`  ${c.cyan("🔎 diagnosis")}  ${dx.rootCause}`);
  console.log(`  ${c.cyan("🛠 proposed")}   ${c.bold(dx.remediation)} ${c.dim(`(confidence: ${dx.confidence})`)}`);
  console.log("");

  // ASK — route the risky action through agentgate
  console.log(`  ${c.yellow("⏸ requesting approval")} — the agent will NOT roll back until a human says so.`);
  console.log(`    Approve or deny at ${c.bold(`${GATE_URL}/?tab=agents`)} ${c.dim("(or the Live tab)")}`);

  let approved = false;
  let decidedBy = "unknown";
  let decisionReason: string | null = null;
  try {
    const decision = await gate.requireApproval({
      action: "k8s.rollback",
      reason: `${dx.headline} — ${dx.remediation}`,
      metadata: {
        ruleId: "incident-rollback",
        category: "incident-response",
        severity: "high",
        impact: {
          headline: dx.headline,
          consequences: [
            `Root cause: ${dx.rootCause}`,
            `Remediation: ${dx.remediation}`,
            `Blast radius: all ${SERVICE} traffic during the rollout`,
          ],
          recoverable: "yes",
          targets: { service: SERVICE, from: dx.fromVersion, to: dx.toVersion },
        },
        tool: "kubectl",
        toolInput: { command: `kubectl rollout undo deploy/${SERVICE}  # ${dx.fromVersion} → ${dx.toVersion}` },
        action: `rollback ${SERVICE} ${dx.fromVersion}→${dx.toVersion}`,
      },
    });
    approved = decision.approved;
    decidedBy = decision.decidedBy ?? "unknown";
    decisionReason = decision.decisionReason;
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      console.log(`\n  ${c.yellow("⏱ approval timed out")} — incident stays open, paging on-call.`);
      process.exit(0);
    }
    throw err;
  }

  // ACT
  console.log("");
  rule();
  if (!approved) {
    console.log(`  ${c.red("✗ denied")} by ${decidedBy}${decisionReason ? c.dim(` — ${decisionReason}`) : ""}`);
    console.log(`  ${c.dim("Agent stands down. Incident remains open; escalating to on-call human.")}`);
    rule();
    console.log(c.dim(`\n  Nothing was changed. The decision + reason are in the audit log.\n`));
    process.exit(0);
  }

  console.log(`  ${c.green("✓ approved")} by ${decidedBy}${decisionReason ? c.dim(` — ${decisionReason}`) : ""}`);
  process.stdout.write(`  ${c.cyan("executing")} ${c.dim(`kubectl rollout undo deploy/${SERVICE} …`)}`);
  await wait(700);
  svc.rollback();
  console.log(c.green("  done"));

  // confirm recovery from the logs
  console.log(c.dim("  verifying recovery from logs…"));
  for (let k = 0; k < 4; k++) {
    const det2 = new Detector(25, 0.15);
    for (let j = 0; j < 25; j++) det2.observe(svc.tick(Date.now()).status);
    console.log(`    ${SERVICE} ${svc.version}  5xx=${c.green(pct(det2.rate))}`);
    await wait(250);
  }
  rule();
  console.log(
    c.green(`\n  ✓ incident resolved`) +
      c.dim(` — ${SERVICE} rolled back to v42, error rate back to baseline.\n`) +
      c.dim(`  The agent detected, diagnosed, and fixed it — but a human approved the\n`) +
      c.dim(`  one risky step, and every action is in the agentgate audit log.\n`),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
