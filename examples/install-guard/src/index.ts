/**
 * install-guard demo
 *
 * Simulates an agent attempting three package installs. For each one, we:
 *   1. scan the package (OSV.dev + registry metadata + typosquat heuristics)
 *   2. seed two policies in agentgate:
 *        - auto-allow when scan.risk == "low"
 *        - auto-deny  when scan.risk == "critical"
 *   3. ask the gate for approval — depending on risk, the request is
 *      auto-allowed, auto-denied, or pending for a human.
 *
 * Run the control plane first:  npm run start
 * Then in another shell:        node examples/install-guard/dist/index.js
 */
import { AgentGate } from "@agentgate/sdk";
import { scan, type ScanResult } from "@agentgate/pkg-scan";

const BASE = process.env.AGENTGATE_URL ?? "http://localhost:4000";

type PolicySeed = {
  name: string;
  description?: string;
  agentPattern?: string;
  actionPattern?: string;
  condition?: unknown;
  effect: "allow" | "deny" | "require_approval";
  priority?: number;
};

async function upsertPolicy(p: PolicySeed): Promise<void> {
  const list = (await (await fetch(`${BASE}/v1/policies`)).json()) as Array<{
    id: string;
    name: string;
  }>;
  const existing = list.find((x) => x.name === p.name);
  if (existing) {
    await fetch(`${BASE}/v1/policies/${existing.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    return;
  }
  const res = await fetch(`${BASE}/v1/policies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(`policy ${p.name} failed: ${await res.text()}`);
}

async function seedInstallPolicies(): Promise<void> {
  await upsertPolicy({
    name: "auto-allow-low-risk-installs",
    description: "Packages the scanner deems low-risk install without bothering anyone.",
    actionPattern: "pkg.install.*",
    condition: { eq: [{ var: "risk" }, "low"] },
    effect: "allow",
    priority: 10,
  });
  await upsertPolicy({
    name: "auto-deny-critical-installs",
    description: "Critical supply-chain risk → never install.",
    actionPattern: "pkg.install.*",
    condition: { eq: [{ var: "risk" }, "critical"] },
    effect: "deny",
    priority: 5,
  });
}

function summarize(s: ScanResult): void {
  console.log(`\n  📦 ${s.ecosystem}:${s.name}@${s.version}  risk=${s.risk.toUpperCase()}`);
  if (s.metadata.publishedAt) {
    console.log(`     published ${s.metadata.publishedAt} (${s.metadata.ageDays}d ago)`);
  }
  if (s.metadata.weeklyDownloads !== undefined) {
    console.log(`     weekly downloads: ${s.metadata.weeklyDownloads.toLocaleString()}`);
  }
  for (const sig of s.signals) {
    console.log(`     • [${sig.severity}] ${sig.kind}: ${sig.message}`);
  }
}

async function tryInstall(opts: {
  agent: string;
  manager: string;
  ecosystem: "npm" | "pypi";
  spec: { name: string; version?: string };
}): Promise<void> {
  console.log(`\n[${opts.manager}] ${opts.agent} → install ${opts.spec.name}${opts.spec.version ? "@" + opts.spec.version : ""}`);
  const result = await scan({
    ecosystem: opts.ecosystem,
    name: opts.spec.name,
    version: opts.spec.version,
  });
  summarize(result);

  const gate = new AgentGate({
    baseUrl: BASE,
    agent: opts.agent,
    pollIntervalMs: 300,
    defaultTimeoutMs: 4_000,
  });

  try {
    const decision = await gate.requireApproval({
      action: `pkg.install.${opts.ecosystem}`,
      reason: `${opts.manager} install ${opts.spec.name} (risk=${result.risk})`,
      metadata: {
        manager: opts.manager,
        ecosystem: opts.ecosystem,
        package: opts.spec.name,
        version: result.version,
        risk: result.risk,
        signals: result.signals,
        meta: result.metadata,
      },
      timeoutMs: 4_000,
    });
    const verdict = decision.approved ? "✅ APPROVED" : "🛑 DENIED";
    console.log(`     → ${verdict} by ${decision.decidedBy}`);
    if (decision.decisionReason) console.log(`       reason: ${decision.decisionReason}`);
  } catch {
    console.log(`     → ⏱  pending (no human in 4s) — would route to dashboard / Slack`);
  }
}

async function main() {
  console.log("[install-guard] seeding install policies");
  await seedInstallPolicies();
  console.log("[install-guard] running three install attempts:");
  console.log("   1. lodash         (popular, low-risk → expect auto-allow)");
  console.log("   2. expreess       (typosquat of express → expect auto-deny)");
  console.log("   3. left-pad       (real but tiny package → expect pending)");

  await tryInstall({
    agent: "code-agent",
    manager: "npm",
    ecosystem: "npm",
    spec: { name: "lodash" },
  });

  await tryInstall({
    agent: "code-agent",
    manager: "npm",
    ecosystem: "npm",
    spec: { name: "expreess" }, // intentional typo
  });

  await tryInstall({
    agent: "code-agent",
    manager: "npm",
    ecosystem: "npm",
    spec: { name: "left-pad" },
  });

  console.log("\n[install-guard] done. open http://localhost:4000 to see the audit log.");
}

main().catch((err) => {
  console.error("[install-guard] fatal:", err);
  process.exit(1);
});
