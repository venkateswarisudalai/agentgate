/**
 * accumulation-demo
 *
 * Shows three new primitives stacked on top of the policy engine:
 *
 *   1. Sessions — every approval is grouped under a session id, so policies
 *      can ask "what has THIS run of the agent done so far?".
 *   2. Windowed/accumulation policies — count(...) and sum(...) operators
 *      count past approvals and sum metadata fields over a time window,
 *      letting you write "no more than N refunds per hour" or
 *      "no more than $X cumulative spend per session".
 *   3. Auto-quarantine — a policy with effect="quarantine_agent" denies
 *      the current request AND quarantines the agent for N minutes,
 *      so every subsequent request from that agent is auto-blocked.
 *
 * Scenario: a refund agent issues several small refunds in quick succession.
 * The 4th refund inside 5 minutes trips an auto-quarantine policy. The
 * 5th refund is then blocked outright by the quarantine state, even though
 * by itself it would have been auto-allowed.
 */
import { AgentGate } from "@agentgate/sdk";

const BASE = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const AGENT = "refund-agent-prod";

type PolicySeed = {
  name: string;
  description?: string;
  agentPattern?: string;
  actionPattern?: string;
  condition?: unknown;
  effect: "allow" | "deny" | "require_approval" | "quarantine_agent";
  priority?: number;
  quarantineMinutes?: number;
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

async function clearQuarantine(): Promise<void> {
  await fetch(`${BASE}/v1/agents/${AGENT}/quarantine`, { method: "DELETE" });
}

async function seedPolicies(): Promise<void> {
  // Auto-allow the small refund (under $50 in USD) — same shape as policy-demo.
  await upsertPolicy({
    name: "auto-allow-tiny-refunds",
    actionPattern: "stripe.refund",
    agentPattern: AGENT,
    condition: {
      all: [
        { lt: [{ var: "amount" }, 50] },
        { eq: [{ var: "currency" }, "USD"] },
      ],
    },
    effect: "allow",
    priority: 50,
  });

  // Auto-quarantine: more than 3 refunds (already approved) by this agent
  // within the last 5 minutes -> quarantine agent for 10 minutes.
  // Note: count uses past approvals, so the policy fires on the request
  // that pushes the running count above the threshold.
  await upsertPolicy({
    name: "quarantine-on-refund-burst",
    description:
      "If the same agent has approved >=3 refunds in the last 5 minutes, " +
      "quarantine for 10 minutes. Catches runaway refund loops.",
    actionPattern: "stripe.refund",
    agentPattern: AGENT,
    condition: {
      gte: [
        {
          count: {
            agent: "self",
            action: "stripe.refund",
            status: ["approved"],
            windowMinutes: 5,
          },
        },
        3,
      ],
    },
    effect: "quarantine_agent",
    priority: 5,
    quarantineMinutes: 10,
  });
}

type Outcome = {
  status: string;
  decidedBy: string | null;
  decisionReason: string | null;
};

async function tryRefund(
  gate: AgentGate,
  sessionId: string,
  i: number,
  amount: number,
): Promise<Outcome> {
  console.log(`\n  [${i}] requesting $${amount} refund`);
  try {
    const decision = await gate.requireApproval({
      action: "stripe.refund",
      reason: `refund #${i}`,
      sessionId,
      metadata: {
        amount,
        currency: "USD",
        orderId: `ord_${i}`,
        attempt: i,
      },
      timeoutMs: 2_000,
    });
    const status = decision.approved ? "approved" : "denied";
    console.log(
      `       ${status === "approved" ? "✅" : "🛑"} ${status} by ${decision.decidedBy}` +
        (decision.decisionReason ? `\n       reason: ${decision.decisionReason}` : ""),
    );
    return {
      status,
      decidedBy: decision.decidedBy,
      decisionReason: decision.decisionReason,
    };
  } catch (err) {
    console.log(`       ⏱  pending (no human in 2s) — would normally route to dashboard`);
    return { status: "pending", decidedBy: null, decisionReason: null };
  }
}

async function showAgentState(): Promise<void> {
  const res = await fetch(`${BASE}/v1/agents/${AGENT}`);
  const state = (await res.json()) as {
    quarantined: boolean;
    quarantinedUntil: string | null;
    quarantineReason: string | null;
  };
  if (state.quarantined) {
    console.log(
      `\n  🚨 agent state: QUARANTINED until ${state.quarantinedUntil}` +
        (state.quarantineReason ? `\n     reason: ${state.quarantineReason}` : ""),
    );
  } else {
    console.log(`\n  agent state: clear`);
  }
}

async function main(): Promise<void> {
  console.log("[demo] resetting agent state + seeding policies");
  await clearQuarantine();
  await seedPolicies();

  const gate = new AgentGate({
    baseUrl: BASE,
    agent: AGENT,
    pollIntervalMs: 200,
    defaultTimeoutMs: 2_000,
  });

  const session = await gate.beginSession({ trigger: "billing-batch" });
  console.log(`[demo] session started: ${session.id}`);

  console.log(
    "\n[demo] firing 5 small refunds. policy: 4th in 5min -> auto-quarantine.",
  );

  for (let i = 1; i <= 5; i++) {
    await tryRefund(gate, session.id, i, 5 + i);
  }

  await showAgentState();

  await gate.endSession(session.id);
  console.log(
    `\n[demo] session ended. open ${BASE} or hit /v1/sessions/${session.id} to inspect.`,
  );
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
