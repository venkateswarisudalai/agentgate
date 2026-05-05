/**
 * scoped-creds-demo
 *
 * Closes the "leaked credentials are valid for unrelated actions" failure
 * mode. The agent never holds long-lived prod credentials. Each approved
 * action is exchanged for a short-lived token bound to (agent, action,
 * scope, expiry). The downstream service (or a verifier proxy) checks the
 * token before doing anything.
 *
 * Six attempts, all routed through the same /v1/credentials/verify endpoint:
 *   1. valid use of the issued token         -> ALLOWED (use 1/1)
 *   2. replay the same token                 -> DENIED (exhausted)
 *   3. wrong action presented                -> DENIED (action_mismatch)
 *   4. wrong agent presented                 -> DENIED (agent_mismatch)
 *   5. amount above scope cap                -> DENIED (scope_violation)
 *   6. token used after revocation           -> DENIED (revoked)
 */
import { AgentGate } from "@agentgate/sdk";

const BASE = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const AGENT = "refund-agent-prod";

async function seedAllowPolicy(): Promise<void> {
  const list = (await (await fetch(`${BASE}/v1/policies`)).json()) as Array<{
    id: string;
    name: string;
  }>;
  const existing = list.find((x) => x.name === "scoped-creds-demo-allow");
  const body = {
    name: "scoped-creds-demo-allow",
    description: "Auto-approve refunds under $50 for the demo.",
    actionPattern: "stripe.refund",
    agentPattern: AGENT,
    condition: { lt: [{ var: "amount" }, 50] },
    effect: "allow",
    priority: 10,
  };
  const url = existing ? `${BASE}/v1/policies/${existing.id}` : `${BASE}/v1/policies`;
  await fetch(url, {
    method: existing ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function attempt(
  label: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${BASE}/v1/credentials/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  const ok = (json as { valid?: boolean }).valid === true;
  if (ok) {
    console.log(
      `  ${label.padEnd(36)} ✅ allowed  (remaining=${(json as { remainingUses: number }).remainingUses})`,
    );
  } else {
    console.log(
      `  ${label.padEnd(36)} 🛑 denied   (${(json as { code: string }).code})`,
    );
  }
}

async function main(): Promise<void> {
  console.log("[demo] seeding policy");
  await seedAllowPolicy();

  const gate = new AgentGate({
    baseUrl: BASE,
    agent: AGENT,
    pollIntervalMs: 200,
  });

  console.log("\n[demo] step 1: agent gets approval for a $5 refund");
  const decision = await gate.requireApproval({
    action: "stripe.refund",
    reason: "customer requested refund for tiny order",
    metadata: { amount: 5, currency: "USD", orderId: "ord_demo" },
  });
  if (!decision.approved) {
    console.error("approval failed unexpectedly");
    process.exit(1);
  }
  console.log(`  approval ${decision.id.slice(0, 8)}... approved by ${decision.decidedBy}`);

  console.log("\n[demo] step 2: exchange approval for a scoped credential");
  const cred = await gate.issueCredential({
    approvalId: decision.id,
    // Scope: amount<=5, currency=USD. Even if the token leaks, it can't
    // authorize a $50 refund or a refund in EUR.
    scope: {
      all: [
        { lte: [{ var: "amount" }, 5] },
        { eq: [{ var: "currency" }, "USD"] },
      ],
    },
    ttlSeconds: 60,
    maxUses: 1,
  });
  console.log(`  token issued, expires ${cred.expiresAt}, scope: amount<=5 AND currency=USD`);

  console.log("\n[demo] running six attempts against /v1/credentials/verify:\n");

  await attempt("1. correct use ($5 USD)", {
    token: cred.token,
    action: "stripe.refund",
    agent: AGENT,
    metadata: { amount: 5, currency: "USD" },
  });

  await attempt("2. replay (max_uses=1)", {
    token: cred.token,
    action: "stripe.refund",
    agent: AGENT,
    metadata: { amount: 5, currency: "USD" },
  });

  // Issue a fresh credential for the remaining attempts.
  const cred2 = await gate.issueCredential({
    approvalId: decision.id,
    scope: {
      all: [
        { lte: [{ var: "amount" }, 5] },
        { eq: [{ var: "currency" }, "USD"] },
      ],
    },
    ttlSeconds: 60,
    maxUses: 1,
  });

  await attempt("3. wrong action", {
    token: cred2.token,
    action: "stripe.payout",
    agent: AGENT,
    metadata: { amount: 5, currency: "USD" },
  });

  await attempt("4. wrong agent", {
    token: cred2.token,
    action: "stripe.refund",
    agent: "different-agent",
    metadata: { amount: 5, currency: "USD" },
  });

  await attempt("5. scope violation ($50 USD)", {
    token: cred2.token,
    action: "stripe.refund",
    agent: AGENT,
    metadata: { amount: 50, currency: "USD" },
  });

  console.log("\n[demo] step 3: revoke the credential");
  await gate.revokeCredential(cred2.credentialId, "demo wrap-up");
  await attempt("6. use after revocation", {
    token: cred2.token,
    action: "stripe.refund",
    agent: AGENT,
    metadata: { amount: 5, currency: "USD" },
  });

  console.log(`\n[demo] done. inspect at ${BASE}/v1/credentials?agent=${AGENT}`);
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
