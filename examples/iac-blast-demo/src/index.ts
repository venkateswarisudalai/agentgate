/**
 * iac-blast-demo
 *
 * An infra agent (think: an agent that reads logs, debugs, writes Terraform)
 * is about to apply a plan. Before agentgate decides anything, the agent
 * submits the plan as JSON. iac-scan parses it into structured signals
 * (destroy on data-loss type, IAM change, security-group change, prod-named
 * target, scope explosion) and produces an overall risk level. That risk
 * level + signals flow into agentgate's policy engine via metadata, and
 * the same operators (count/sum/eq/gte/etc) decide allow/deny/route-to-human.
 *
 * Three plans are exercised here:
 *   1. small benign update on a staging cluster      -> low risk, auto-allow
 *   2. plan that deletes prod RDS + opens SG to 0/0  -> critical, auto-deny
 *   3. routine apply of a moderate-size service plan -> medium, route to human
 */
import { AgentGate } from "@agentgate/sdk";
import { parseTerraformPlan, parseKubectlDryRun } from "@agentgate/iac-scan";

const BASE = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const AGENT = "infra-agent-prod";

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
  const url = existing ? `${BASE}/v1/policies/${existing.id}` : `${BASE}/v1/policies`;
  await fetch(url, {
    method: existing ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
}

async function seedPolicies(): Promise<void> {
  await upsertPolicy({
    name: "iac-auto-allow-low",
    description: "Plans the scanner deems low-risk auto-apply.",
    actionPattern: "iac.apply.*",
    agentPattern: AGENT,
    condition: { eq: [{ var: "blastRadius.risk" }, "low"] },
    effect: "allow",
    priority: 10,
  });
  await upsertPolicy({
    name: "iac-auto-deny-critical",
    description: "Plans with critical blast radius -- never apply.",
    actionPattern: "iac.apply.*",
    agentPattern: AGENT,
    condition: { eq: [{ var: "blastRadius.risk" }, "critical"] },
    effect: "deny",
    priority: 5,
  });
}

const benignPlan = {
  resource_changes: [
    {
      address: "aws_instance.staging-app[0]",
      type: "aws_instance",
      name: "staging-app",
      change: {
        actions: ["update"],
        before: { tags: { env: "staging" }, instance_type: "t3.small" },
        after: { tags: { env: "staging" }, instance_type: "t3.medium" },
      },
    },
  ],
};

const dangerousPlan = {
  resource_changes: [
    {
      address: "aws_db_instance.prod-main",
      type: "aws_db_instance",
      name: "prod-main",
      change: { actions: ["delete"], before: {}, after: null },
    },
    {
      address: "aws_security_group.prod-web",
      type: "aws_security_group",
      name: "prod-web",
      change: {
        actions: ["update"],
        before: { ingress: [] },
        after: { ingress: [{ cidr_blocks: ["0.0.0.0/0"], from_port: 22, to_port: 22 }] },
      },
    },
    {
      address: "aws_iam_role.prod-admin",
      type: "aws_iam_role",
      name: "prod-admin",
      change: { actions: ["update"], before: { name: "prod-admin" }, after: { name: "prod-admin" } },
    },
  ],
};

const moderatePlan = {
  resource_changes: Array.from({ length: 22 }, (_, i) => ({
    address: `aws_lambda_function.svc-${i}`,
    type: "aws_lambda_function",
    name: `svc-${i}`,
    change: { actions: ["update"], before: { memory_size: 256 }, after: { memory_size: 512 } },
  })),
};

async function tryApply(label: string, plan: object): Promise<void> {
  const blast = parseTerraformPlan(plan);
  console.log(`\n  📋 ${label}`);
  console.log(`     ${blast.summary}`);
  console.log(`     risk = ${blast.risk.toUpperCase()}`);
  for (const s of blast.signals.slice(0, 5)) {
    console.log(`     • [${s.severity}] ${s.kind}: ${s.message}`);
  }
  if (blast.signals.length > 5) {
    console.log(`     • ... and ${blast.signals.length - 5} more`);
  }

  const gate = new AgentGate({
    baseUrl: BASE,
    agent: AGENT,
    pollIntervalMs: 200,
    defaultTimeoutMs: 3_000,
  });

  try {
    const decision = await gate.requireApproval({
      action: "iac.apply.terraform",
      reason: `agent applying: ${label}`,
      metadata: {
        blastRadius: {
          risk: blast.risk,
          summary: blast.summary,
          counts: blast.counts,
          signals: blast.signals,
        },
      },
      timeoutMs: 3_000,
    });
    const verdict = decision.approved ? "✅ APPROVED" : "🛑 DENIED";
    console.log(`     → ${verdict} by ${decision.decidedBy}`);
  } catch {
    console.log(`     → ⏱  pending (no human in 3s) — would route to dashboard`);
  }
}

async function main(): Promise<void> {
  console.log("[demo] seeding policies");
  await seedPolicies();
  console.log("[demo] running three Terraform plans through the gate:");

  await tryApply(
    "small staging update (resize 1 instance)",
    benignPlan,
  );
  await tryApply(
    "destroy prod-main RDS + open security group + IAM update",
    dangerousPlan,
  );
  await tryApply(
    "moderate plan: 22 lambda memory bumps (no destroys)",
    moderatePlan,
  );

  // bonus: a tiny kubectl dry-run example
  const kube = parseKubectlDryRun(
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "billing-prod" },
    },
    "delete",
  );
  console.log(
    `\n  ⛅ kubectl delete ns billing-prod  →  risk=${kube.risk.toUpperCase()}  signals=${kube.signals.length}`,
  );
  for (const s of kube.signals) console.log(`     • [${s.severity}] ${s.kind}: ${s.message}`);

  console.log("\n[demo] done. open the dashboard to see signals attached to each approval.");
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
