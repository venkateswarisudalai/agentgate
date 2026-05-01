import { AgentGate } from "@agentgate/sdk";

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
  if (!res.ok) throw new Error(`failed to create policy ${p.name}: ${await res.text()}`);
}

async function seedPolicies(): Promise<void> {
  console.log("[demo] seeding policies\n");

  await upsertPolicy({
    name: "auto-allow-tiny-refunds",
    description: "Refunds under $50 in USD auto-approve.",
    agentPattern: "support-*",
    actionPattern: "stripe.refund",
    condition: {
      all: [
        { lt: [{ var: "amount" }, 50] },
        { eq: [{ var: "currency" }, "USD" ] },
      ],
    },
    effect: "allow",
    priority: 10,
  });

  await upsertPolicy({
    name: "auto-deny-huge-refunds",
    description: "Refunds at or above $10,000 auto-deny.",
    agentPattern: "support-*",
    actionPattern: "stripe.refund",
    condition: { gte: [{ var: "amount" }, 10000] },
    effect: "deny",
    priority: 20,
  });

  await upsertPolicy({
    name: "always-deny-prod-table-drop",
    description: "Hard rule: never let any agent drop a prod table.",
    actionPattern: "postgres.drop_table",
    condition: { eq: [{ var: "database" }, "prod-main"] },
    effect: "deny",
    priority: 5,
  });
}

async function tryAction(opts: {
  label: string;
  agent: string;
  action: string;
  reason: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const gate = new AgentGate({
    baseUrl: BASE,
    agent: opts.agent,
    pollIntervalMs: 300,
    defaultTimeoutMs: 5_000,
  });
  console.log(`\n[${opts.label}] ${opts.agent} -> ${opts.action}`);
  console.log(`[${opts.label}] metadata: ${JSON.stringify(opts.metadata)}`);
  try {
    const decision = await gate.requireApproval({
      action: opts.action,
      reason: opts.reason,
      metadata: opts.metadata,
      timeoutMs: 3_000,
    });
    const verdict = decision.approved ? "✅ APPROVED" : "🛑 DENIED";
    console.log(`[${opts.label}] ${verdict} by ${decision.decidedBy}`);
    if (decision.decisionReason) {
      console.log(`[${opts.label}]   reason: ${decision.decisionReason}`);
    }
  } catch (err) {
    console.log(`[${opts.label}] ⏱  pending (no human acted in 3s) — manual path works`);
  }
}

async function main(): Promise<void> {
  await seedPolicies();
  console.log("[demo] policies in place. running three approval requests:\n");
  console.log("  1. $5 refund   → expect auto-allow");
  console.log("  2. $25,000 refund → expect auto-deny");
  console.log("  3. $500 refund → expect manual (timeout in 3s)");

  await tryAction({
    label: "tiny",
    agent: "support-bot-prod",
    action: "stripe.refund",
    reason: "customer asked for refund on small order",
    metadata: { amount: 5, currency: "USD", orderId: "ord_aaa" },
  });

  await tryAction({
    label: "huge",
    agent: "support-bot-prod",
    action: "stripe.refund",
    reason: "customer asked for full refund",
    metadata: { amount: 25_000, currency: "USD", orderId: "ord_bbb" },
  });

  await tryAction({
    label: "manual",
    agent: "support-bot-prod",
    action: "stripe.refund",
    reason: "customer asked for partial refund",
    metadata: { amount: 500, currency: "USD", orderId: "ord_ccc" },
  });

  console.log("\n[demo] done. open http://localhost:4000 to see the audit log.");
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
