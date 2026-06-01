import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb } from "../src/db.ts";
import { registerRoutes } from "../src/routes.ts";
import type { AuthConfig } from "../src/auth.ts";

let counter = 0;
async function makeApp(
  auth?: AuthConfig,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const dbPath = `/tmp/agentgate-routes-${process.pid}-${Date.now()}-${counter++}.db`;
  const db = openDb(dbPath);
  const app = Fastify({ logger: false });
  registerRoutes(app, db, auth);
  await app.ready();
  return {
    app,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

// Team-mode auth fixture: operator 'alice' can approve, agent 'bot' cannot.
function teamAuth(): AuthConfig {
  return {
    tokens: new Map([
      ["op-tok", { id: "alice@co", role: "operator" }],
      ["agent-tok", { id: "bot", role: "agent" }],
    ]),
    configured: true,
    devActor: "local:test",
  };
}

async function postJSON(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: "POST", url, payload, headers });
  return { status: res.statusCode, body: res.json() };
}

async function getJSON(
  app: FastifyInstance,
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.json() };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// ---------- approvals ----------

test("POST /v1/approvals: 400 on missing fields", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await postJSON(app, "/v1/approvals", { agent: "x" });
    assert.equal(r.status, 400);
  } finally {
    await close();
  }
});

test("POST /v1/approvals: creates pending approval (no policy)", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await postJSON(app, "/v1/approvals", {
      agent: "support-bot",
      action: "stripe.refund",
      reason: "test",
      metadata: { amount: 5 },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.id);
    assert.equal(r.body.status, "pending");

    const got = await getJSON(app, `/v1/approvals/${r.body.id}`);
    assert.equal(got.body.status, "pending");
    assert.equal(got.body.agent, "support-bot");
  } finally {
    await close();
  }
});

test("POST /v1/approvals: auto-allow via policy short-circuits", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/policies", {
      name: "tiny-allow",
      actionPattern: "stripe.refund",
      condition: { lt: [{ var: "amount" }, 50] },
      effect: "allow",
      priority: 10,
    });

    const r = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "stripe.refund",
      reason: "tiny",
      metadata: { amount: 5 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "approved");
    assert.equal(r.body.decidedBy, "policy:tiny-allow");

    const audit = await getJSON(app, `/v1/approvals/${r.body.id}/audit`);
    const events = audit.body.map((e: any) => e.event);
    assert.ok(events.includes("approval.created"));
    assert.ok(events.includes("approval.auto_approved"));
  } finally {
    await close();
  }
});

test("POST /v1/approvals: auto-deny via policy", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/policies", {
      name: "huge-deny",
      actionPattern: "stripe.refund",
      condition: { gte: [{ var: "amount" }, 1000] },
      effect: "deny",
      priority: 5,
    });

    const r = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "stripe.refund",
      reason: "huge",
      metadata: { amount: 5000 },
    });
    assert.equal(r.body.status, "denied");
    assert.equal(r.body.decidedBy, "policy:huge-deny");
  } finally {
    await close();
  }
});

test("POST /v1/approvals: priority-ordered match", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/policies", {
      name: "low-prio-allow",
      actionPattern: "*",
      condition: true,
      effect: "allow",
      priority: 100,
    });
    await postJSON(app, "/v1/policies", {
      name: "high-prio-deny",
      actionPattern: "*",
      condition: true,
      effect: "deny",
      priority: 1,
    });
    const r = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "y",
      reason: "z",
    });
    assert.equal(r.body.status, "denied");
    assert.equal(r.body.decidedBy, "policy:high-prio-deny");
  } finally {
    await close();
  }
});

test("POST /v1/approvals/:id/decide: dev mode stamps local identity, ignores body decidedBy", async () => {
  const { app, close } = await makeApp();
  try {
    const created = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "y",
      reason: "z",
    });
    const decided = await postJSON(app, `/v1/approvals/${created.body.id}/decide`, {
      approved: true,
      // Spoof attempt — must be ignored. Identity comes from the principal.
      decidedBy: "alice@example.com",
      reason: "looks fine",
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, "approved");
    // NOT "alice@example.com" — the forged identity is dropped.
    assert.equal(decided.body.decidedBy, "local:dev");
    assert.equal(decided.body.decisionReason, "looks fine");
  } finally {
    await close();
  }
});

// ---------- auth (team mode) ----------

test("team mode: mutating route without token -> 401", async () => {
  const { app, close } = await makeApp(teamAuth());
  try {
    const r = await postJSON(app, "/v1/approvals", {
      agent: "bot",
      action: "y",
      reason: "z",
    });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});

test("team mode: operator approves; identity bound to token, not body", async () => {
  const { app, close } = await makeApp(teamAuth());
  try {
    const created = await postJSON(
      app,
      "/v1/approvals",
      { agent: "bot", action: "y", reason: "z" },
      bearer("agent-tok"),
    );
    const decided = await postJSON(
      app,
      `/v1/approvals/${created.body.id}/decide`,
      { approved: true, decidedBy: "mallory", reason: "ok" },
      bearer("op-tok"),
    );
    assert.equal(decided.status, 200);
    assert.equal(decided.body.decidedBy, "alice@co");
  } finally {
    await close();
  }
});

test("team mode: agent role cannot approve -> 403", async () => {
  const { app, close } = await makeApp(teamAuth());
  try {
    const created = await postJSON(
      app,
      "/v1/approvals",
      { agent: "other", action: "y", reason: "z" },
      bearer("agent-tok"),
    );
    const decided = await postJSON(
      app,
      `/v1/approvals/${created.body.id}/decide`,
      { approved: true },
      bearer("agent-tok"),
    );
    assert.equal(decided.status, 403);
  } finally {
    await close();
  }
});

test("team mode: requester cannot approve their own request -> 403", async () => {
  // Operator 'alice@co' files a request as agent 'alice@co', then tries to
  // self-approve. Separation of duties must block it.
  const { app, close } = await makeApp(teamAuth());
  try {
    const created = await postJSON(
      app,
      "/v1/approvals",
      { agent: "alice@co", action: "y", reason: "z" },
      bearer("op-tok"),
    );
    const decided = await postJSON(
      app,
      `/v1/approvals/${created.body.id}/decide`,
      { approved: true },
      bearer("op-tok"),
    );
    assert.equal(decided.status, 403);
  } finally {
    await close();
  }
});

test("POST /v1/approvals/:id/decide: cannot re-decide", async () => {
  const { app, close } = await makeApp();
  try {
    const created = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "y",
      reason: "z",
    });
    await postJSON(app, `/v1/approvals/${created.body.id}/decide`, { approved: true });
    const second = await postJSON(app, `/v1/approvals/${created.body.id}/decide`, {
      approved: false,
    });
    assert.equal(second.status, 409);
  } finally {
    await close();
  }
});

// ---------- policies CRUD ----------

test("POST /v1/policies: 400 on bad effect", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await postJSON(app, "/v1/policies", { name: "x", effect: "bogus" });
    assert.equal(r.status, 400);
  } finally {
    await close();
  }
});

test("POST /v1/policies: 409 on duplicate name", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/policies", { name: "dup", effect: "allow" });
    const r = await postJSON(app, "/v1/policies", { name: "dup", effect: "deny" });
    assert.equal(r.status, 409);
  } finally {
    await close();
  }
});

test("POST /v1/policies/test: dry-run", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/policies", {
      name: "tiny-allow",
      actionPattern: "stripe.refund",
      condition: { lt: [{ var: "amount" }, 50] },
      effect: "allow",
      priority: 10,
    });
    const r = await postJSON(app, "/v1/policies/test", {
      agent: "x",
      action: "stripe.refund",
      metadata: { amount: 5 },
    });
    assert.equal(r.body.decision, "approved");
    assert.equal(r.body.match.policyName, "tiny-allow");

    const miss = await postJSON(app, "/v1/policies/test", {
      agent: "x",
      action: "stripe.refund",
      metadata: { amount: 999 },
    });
    assert.equal(miss.body.decision, "pending");
    assert.equal(miss.body.match, null);
  } finally {
    await close();
  }
});

// ---------- sessions ----------

test("sessions: create, attach approvals, end", async () => {
  const { app, close } = await makeApp();
  try {
    const session = await postJSON(app, "/v1/sessions", {
      agent: "support-bot",
      metadata: { trigger: "test" },
    });
    assert.equal(session.status, 201);
    const sid = session.body.id;

    await postJSON(app, "/v1/approvals", {
      agent: "support-bot",
      action: "a.b",
      reason: "in session",
      sessionId: sid,
    });

    const got = await getJSON(app, `/v1/sessions/${sid}`);
    assert.equal(got.body.status, "active");
    assert.equal(got.body.approvals.length, 1);
    assert.equal(got.body.approvals[0].sessionId, sid);

    const ended = await postJSON(app, `/v1/sessions/${sid}/end`, {});
    assert.equal(ended.body.status, "ended");
    assert.ok(ended.body.endedAt);
  } finally {
    await close();
  }
});

test("sessions: bad sessionId on approval -> 400", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "y",
      reason: "z",
      sessionId: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(r.status, 400);
  } finally {
    await close();
  }
});

// ---------- agent state / quarantine ----------

test("quarantine: manual set + automatic block of subsequent calls", async () => {
  const { app, close } = await makeApp();
  try {
    await postJSON(app, "/v1/agents/spammy/quarantine", {
      minutes: 10,
      reason: "manual",
    });
    const state = await getJSON(app, "/v1/agents/spammy");
    assert.equal(state.body.quarantined, true);

    // Subsequent approval is denied at the door
    const r = await postJSON(app, "/v1/approvals", {
      agent: "spammy",
      action: "anything",
      reason: "test",
    });
    assert.equal(r.body.status, "denied");
    assert.equal(r.body.decidedBy, "agentgate:quarantine");

    // Release
    const released = await app.inject({
      method: "DELETE",
      url: "/v1/agents/spammy/quarantine",
    });
    assert.equal(released.statusCode, 200);

    // Now next approval falls through to pending
    const ok = await postJSON(app, "/v1/approvals", {
      agent: "spammy",
      action: "anything",
      reason: "test",
    });
    assert.equal(ok.body.status, "pending");
  } finally {
    await close();
  }
});

test("quarantine_agent effect: policy denies + quarantines agent", async () => {
  const { app, close } = await makeApp();
  try {
    // Pre-seed: 3 prior approved refunds in the recent window
    const seed = async () => {
      await postJSON(app, "/v1/policies", {
        name: "tiny-allow",
        actionPattern: "stripe.refund",
        condition: { lt: [{ var: "amount" }, 50] },
        effect: "allow",
        priority: 50,
      });
      await postJSON(app, "/v1/policies", {
        name: "burst-quarantine",
        actionPattern: "stripe.refund",
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
    };
    await seed();

    for (let i = 0; i < 3; i++) {
      const r = await postJSON(app, "/v1/approvals", {
        agent: "burst-bot",
        action: "stripe.refund",
        reason: `r${i}`,
        metadata: { amount: 5 },
      });
      assert.equal(r.body.status, "approved", `attempt ${i + 1}`);
    }

    // 4th request should trigger the quarantine policy
    const fourth = await postJSON(app, "/v1/approvals", {
      agent: "burst-bot",
      action: "stripe.refund",
      reason: "r4",
      metadata: { amount: 5 },
    });
    assert.equal(fourth.body.status, "denied");
    assert.equal(fourth.body.decidedBy, "policy:burst-quarantine");

    // 5th request blocked by quarantine state directly
    const fifth = await postJSON(app, "/v1/approvals", {
      agent: "burst-bot",
      action: "stripe.refund",
      reason: "r5",
      metadata: { amount: 5 },
    });
    assert.equal(fifth.body.decidedBy, "agentgate:quarantine");

    // Different agent unaffected
    const other = await postJSON(app, "/v1/approvals", {
      agent: "calm-bot",
      action: "stripe.refund",
      reason: "fine",
      metadata: { amount: 5 },
    });
    assert.equal(other.body.status, "approved");
  } finally {
    await close();
  }
});

// ---------- tamper-evident audit ----------

test("audit: hash chain verifies over real route traffic", async () => {
  const { app, close } = await makeApp();
  try {
    const created = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "y",
      reason: "z",
    });
    await postJSON(app, `/v1/approvals/${created.body.id}/decide`, { approved: true });

    const verify = await getJSON(app, "/v1/audit/verify");
    assert.equal(verify.body.ok, true);
    assert.ok(verify.body.length >= 2);
  } finally {
    await close();
  }
});

// ---------- redaction ----------

test("redaction: secrets in approval metadata are scrubbed on read", async () => {
  const { app, close } = await makeApp();
  try {
    const created = await postJSON(app, "/v1/approvals", {
      agent: "x",
      action: "db.connect",
      reason: "needs creds",
      metadata: {
        password: "hunter2",
        toolInput: { command: "psql postgres://user:s3cr3t@db.prod/app" },
        amount: 42,
      },
    });
    const got = await getJSON(app, `/v1/approvals/${created.body.id}`);
    assert.equal(got.body.metadata.password, "«redacted»");
    assert.ok(!JSON.stringify(got.body.metadata).includes("hunter2"));
    assert.ok(!JSON.stringify(got.body.metadata).includes("s3cr3t"));
    // Non-secret structure survives.
    assert.equal(got.body.metadata.amount, 42);

    // And the persisted audit payload is redacted too.
    const audit = await getJSON(app, "/v1/audit");
    assert.ok(!JSON.stringify(audit.body).includes("hunter2"));
  } finally {
    await close();
  }
});

// ---------- shadow ledger ----------

test("shadow: record + list with totals", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await postJSON(app, "/v1/shadow", {
      agent: "claude-code",
      action: "claude-code.Bash",
      severity: "high",
      reason: "rm -rf would have been gated",
      source: "hook",
      metadata: { password: "leakme", note: "ok" },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.id);

    const list = await getJSON(app, "/v1/shadow");
    assert.equal(list.body.total, 1);
    assert.equal(list.body.entries[0].agent, "claude-code");
    // Shadow metadata is redacted at rest too.
    assert.equal(list.body.entries[0].metadata.password, "«redacted»");

    const bad = await postJSON(app, "/v1/shadow", { agent: "x" });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

// ---------- health ----------

test("/healthz returns ok", async () => {
  const { app, close } = await makeApp();
  try {
    const r = await getJSON(app, "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally {
    await close();
  }
});
