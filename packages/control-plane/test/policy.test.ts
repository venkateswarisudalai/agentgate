import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openDb } from "../src/db.ts";
import {
  clearQuarantine,
  evalCondition,
  evaluatePolicies,
  getQuarantineState,
  globToRegex,
  PolicyConditionError,
  setQuarantine,
} from "../src/policy.ts";

let counter = 0;
function freshDb(): Database.Database {
  return openDb(`/tmp/agentgate-test-${process.pid}-${Date.now()}-${counter++}.db`);
}

const probe = { agent: "agent-x", action: "act-x", metadata: {}, sessionId: null };

// ---------- evalCondition: literals ----------

test("evalCondition: literal pass-through", async () => {
  const db = freshDb();
  assert.equal(await evalCondition(true, probe, db), true);
  assert.equal(await evalCondition(false, probe, db), false);
  assert.equal(await evalCondition(42, probe, db), 42);
  assert.equal(await evalCondition("hello", probe, db), "hello");
  assert.equal(await evalCondition(null, probe, db), null);
});

// ---------- evalCondition: var path access ----------

test("evalCondition: var resolves nested metadata paths", async () => {
  const db = freshDb();
  const ctx = { ...probe, metadata: { amount: 5, order: { id: "abc", lines: 3 } } };
  assert.equal(await evalCondition({ var: "amount" }, ctx, db), 5);
  assert.equal(await evalCondition({ var: "order.id" }, ctx, db), "abc");
  assert.equal(await evalCondition({ var: "order.lines" }, ctx, db), 3);
  assert.equal(await evalCondition({ var: "missing" }, ctx, db), undefined);
  assert.equal(await evalCondition({ var: "missing.deeper" }, ctx, db), undefined);
});

test("evalCondition: var requires string path", async () => {
  const db = freshDb();
  await assert.rejects(
    () => evalCondition({ var: 42 }, probe, db),
    PolicyConditionError,
  );
});

// ---------- evalCondition: comparison ops ----------

test("evalCondition: eq / ne", async () => {
  const db = freshDb();
  assert.equal(await evalCondition({ eq: [1, 1] }, probe, db), true);
  assert.equal(await evalCondition({ eq: [1, 2] }, probe, db), false);
  assert.equal(await evalCondition({ eq: ["a", "a"] }, probe, db), true);
  assert.equal(await evalCondition({ ne: [1, 2] }, probe, db), true);
  assert.equal(await evalCondition({ ne: [1, 1] }, probe, db), false);
});

test("evalCondition: lt / lte / gt / gte require numeric on both sides", async () => {
  const db = freshDb();
  assert.equal(await evalCondition({ lt: [1, 2] }, probe, db), true);
  assert.equal(await evalCondition({ lt: [2, 2] }, probe, db), false);
  assert.equal(await evalCondition({ lte: [2, 2] }, probe, db), true);
  assert.equal(await evalCondition({ gt: [3, 2] }, probe, db), true);
  assert.equal(await evalCondition({ gte: [2, 2] }, probe, db), true);
  // non-numeric fails (returns false, not throws)
  assert.equal(await evalCondition({ lt: ["a", "b"] }, probe, db), false);
  assert.equal(await evalCondition({ gt: [1, "x"] }, probe, db), false);
});

// ---------- evalCondition: logical ----------

test("evalCondition: all / any / not", async () => {
  const db = freshDb();
  assert.equal(await evalCondition({ all: [true, true] }, probe, db), true);
  assert.equal(await evalCondition({ all: [true, false] }, probe, db), false);
  assert.equal(await evalCondition({ all: [] }, probe, db), true); // vacuously true
  assert.equal(await evalCondition({ any: [false, true] }, probe, db), true);
  assert.equal(await evalCondition({ any: [false, false] }, probe, db), false);
  assert.equal(await evalCondition({ any: [] }, probe, db), false);
  assert.equal(await evalCondition({ not: false }, probe, db), true);
  assert.equal(await evalCondition({ not: true }, probe, db), false);
});

test("evalCondition: composed expressions", async () => {
  const db = freshDb();
  const ctx = { ...probe, metadata: { amount: 5, currency: "USD" } };
  const expr = {
    all: [
      { lt: [{ var: "amount" }, 50] },
      { eq: [{ var: "currency" }, "USD"] },
    ],
  };
  assert.equal(await evalCondition(expr, ctx, db), true);
  const ctx2 = { ...probe, metadata: { amount: 100, currency: "USD" } };
  assert.equal(await evalCondition(expr, ctx2, db), false);
});

// ---------- evalCondition: in / match ----------

test("evalCondition: in needle/haystack", async () => {
  const db = freshDb();
  assert.equal(await evalCondition({ in: ["a", ["a", "b"]] }, probe, db), true);
  assert.equal(await evalCondition({ in: ["c", ["a", "b"]] }, probe, db), false);
  assert.equal(await evalCondition({ in: [1, "not-an-array"] }, probe, db), false);
});

test("evalCondition: match regex on string value", async () => {
  const db = freshDb();
  assert.equal(await evalCondition({ match: ["foo123", "^foo\\d+$"] }, probe, db), true);
  assert.equal(await evalCondition({ match: ["bar", "^foo"] }, probe, db), false);
  assert.equal(await evalCondition({ match: [42, "^foo"] }, probe, db), false);
});

// ---------- evalCondition: errors ----------

test("evalCondition: unknown operator throws", async () => {
  const db = freshDb();
  await assert.rejects(
    () => evalCondition({ frobnicate: [1] }, probe, db),
    PolicyConditionError,
  );
});

test("evalCondition: multi-key node throws", async () => {
  const db = freshDb();
  await assert.rejects(
    () => evalCondition({ eq: [1, 1], lt: [1, 2] }, probe, db),
    PolicyConditionError,
  );
});

// ---------- count operator ----------

test("count: empty database returns 0", async () => {
  const db = freshDb();
  const n = await evalCondition(
    { count: { agent: "self", action: "stripe.refund", windowMinutes: 60 } },
    { ...probe, agent: "x" },
    db,
  );
  assert.equal(n, 0);
});

test("count: filters by agent (self) and action, ignores other agents", async () => {
  const db = freshDb();
  // Insert two approvals: one matching, one for a different agent.
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status)
     VALUES ('a1','agent-X','stripe.refund','r','{}','approved'),
            ('a2','agent-Y','stripe.refund','r','{}','approved')`,
  ).run();
  const n = await evalCondition(
    { count: { agent: "self", action: "stripe.refund" } },
    { ...probe, agent: "agent-X" },
    db,
  );
  assert.equal(n, 1);
});

test("count: glob action pattern", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status)
     VALUES ('b1','x','stripe.refund','r','{}','approved'),
            ('b2','x','stripe.payout','r','{}','approved'),
            ('b3','x','postgres.write','r','{}','approved')`,
  ).run();
  const n = await evalCondition(
    { count: { agent: "x", action: "stripe.*" } },
    probe,
    db,
  );
  assert.equal(n, 2);
});

test("count: status filter", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status)
     VALUES ('c1','x','a','r','{}','approved'),
            ('c2','x','a','r','{}','denied'),
            ('c3','x','a','r','{}','pending')`,
  ).run();
  const approved = (await evalCondition(
    { count: { agent: "x", status: ["approved"] } },
    probe,
    db,
  )) as number;
  assert.equal(approved, 1);
  const both = (await evalCondition(
    { count: { agent: "x", status: ["approved", "denied"] } },
    probe,
    db,
  )) as number;
  assert.equal(both, 2);
});

test("count: window only includes recent rows", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status, created_at)
     VALUES ('d1','x','a','r','{}','approved', datetime('now', '-2 minutes')),
            ('d2','x','a','r','{}','approved', datetime('now', '-30 minutes')),
            ('d3','x','a','r','{}','approved', datetime('now', '-2 hours'))`,
  ).run();
  const last5 = (await evalCondition(
    { count: { agent: "x", windowMinutes: 5 } },
    probe,
    db,
  )) as number;
  assert.equal(last5, 1);
  const last60 = (await evalCondition(
    { count: { agent: "x", windowMinutes: 60 } },
    probe,
    db,
  )) as number;
  assert.equal(last60, 2);
});

// ---------- sum operator ----------

test("sum: numeric metadata field", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status)
     VALUES ('s1','x','a','r','{"amount":5}','approved'),
            ('s2','x','a','r','{"amount":12}','approved'),
            ('s3','x','a','r','{"amount":"NaN"}','approved')`,
  ).run();
  const total = (await evalCondition(
    { sum: { agent: "x", field: "amount" } },
    probe,
    db,
  )) as number;
  assert.equal(total, 17); // string amount ignored
});

test("sum: missing field treated as 0", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO approvals (id, agent, action, reason, metadata, status)
     VALUES ('s4','x','a','r','{}','approved')`,
  ).run();
  const total = (await evalCondition(
    { sum: { agent: "x", field: "nope" } },
    probe,
    db,
  )) as number;
  assert.equal(total, 0);
});

// ---------- globToRegex ----------

test("globToRegex: literal", () => {
  const re = globToRegex("foo");
  assert.equal(re.test("foo"), true);
  assert.equal(re.test("foox"), false);
});

test("globToRegex: star wildcards anything", () => {
  const re = globToRegex("stripe.*");
  assert.equal(re.test("stripe.refund"), true);
  assert.equal(re.test("stripe.payout"), true);
  assert.equal(re.test("postgres.refund"), false);
});

test("globToRegex: question matches single char", () => {
  const re = globToRegex("ab?");
  assert.equal(re.test("abc"), true);
  assert.equal(re.test("ab"), false);
  assert.equal(re.test("abcd"), false);
});

test("globToRegex: regex specials are escaped", () => {
  const re = globToRegex("a.b+c");
  assert.equal(re.test("a.b+c"), true);
  assert.equal(re.test("axbxc"), false); // dots/plus literal, not regex
});

// ---------- evaluatePolicies ----------

function insertPolicy(
  db: Database.Database,
  args: {
    id: string;
    name: string;
    effect: "allow" | "deny" | "require_approval" | "quarantine_agent";
    priority: number;
    agent_pattern?: string;
    action_pattern?: string;
    condition?: string;
    enabled?: number;
    quarantine_minutes?: number;
  },
): void {
  db.prepare(
    `INSERT INTO policies (id, name, agent_pattern, action_pattern, condition, effect, priority, enabled, quarantine_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.name,
    args.agent_pattern ?? "*",
    args.action_pattern ?? "*",
    args.condition ?? "true",
    args.effect,
    args.priority,
    args.enabled ?? 1,
    args.quarantine_minutes ?? 60,
  );
}

test("evaluatePolicies: no rules -> null", async () => {
  const db = freshDb();
  const m = await evaluatePolicies(db, { agent: "x", action: "y", metadata: {} });
  assert.equal(m, null);
});

test("evaluatePolicies: priority lowest wins", async () => {
  const db = freshDb();
  insertPolicy(db, { id: "p1", name: "low", effect: "allow", priority: 100 });
  insertPolicy(db, { id: "p2", name: "high", effect: "deny", priority: 5 });
  const m = await evaluatePolicies(db, { agent: "x", action: "y", metadata: {} });
  assert.equal(m?.policyName, "high");
  assert.equal(m?.effect, "deny");
});

test("evaluatePolicies: agent_pattern filter", async () => {
  const db = freshDb();
  insertPolicy(db, {
    id: "p3",
    name: "support-only",
    effect: "allow",
    priority: 10,
    agent_pattern: "support-*",
  });
  const hit = await evaluatePolicies(db, {
    agent: "support-bot",
    action: "any",
    metadata: {},
  });
  assert.equal(hit?.policyName, "support-only");
  const miss = await evaluatePolicies(db, {
    agent: "ops-bot",
    action: "any",
    metadata: {},
  });
  assert.equal(miss, null);
});

test("evaluatePolicies: condition false -> skipped", async () => {
  const db = freshDb();
  insertPolicy(db, {
    id: "p4",
    name: "tiny-only",
    effect: "allow",
    priority: 10,
    condition: JSON.stringify({ lt: [{ var: "amount" }, 50] }),
  });
  const hit = await evaluatePolicies(db, {
    agent: "x",
    action: "y",
    metadata: { amount: 10 },
  });
  assert.equal(hit?.policyName, "tiny-only");
  const miss = await evaluatePolicies(db, {
    agent: "x",
    action: "y",
    metadata: { amount: 100 },
  });
  assert.equal(miss, null);
});

test("evaluatePolicies: disabled rules skipped", async () => {
  const db = freshDb();
  insertPolicy(db, {
    id: "p5",
    name: "off",
    effect: "deny",
    priority: 1,
    enabled: 0,
  });
  insertPolicy(db, { id: "p6", name: "on", effect: "allow", priority: 10 });
  const m = await evaluatePolicies(db, { agent: "x", action: "y", metadata: {} });
  assert.equal(m?.policyName, "on");
});

test("evaluatePolicies: malformed condition silently skipped (graceful)", async () => {
  const db = freshDb();
  insertPolicy(db, {
    id: "p7",
    name: "broken",
    effect: "deny",
    priority: 1,
    condition: "{not valid json",
  });
  insertPolicy(db, { id: "p8", name: "ok", effect: "allow", priority: 10 });
  const m = await evaluatePolicies(db, { agent: "x", action: "y", metadata: {} });
  assert.equal(m?.policyName, "ok");
});

test("evaluatePolicies: returns quarantineMinutes from policy row", async () => {
  const db = freshDb();
  insertPolicy(db, {
    id: "p9",
    name: "q",
    effect: "quarantine_agent",
    priority: 1,
    quarantine_minutes: 25,
  });
  const m = await evaluatePolicies(db, { agent: "x", action: "y", metadata: {} });
  assert.equal(m?.effect, "quarantine_agent");
  assert.equal(m?.quarantineMinutes, 25);
});

// ---------- quarantine ----------

test("quarantine: clean state -> not quarantined", () => {
  const db = freshDb();
  const s = getQuarantineState(db, "agent-y");
  assert.equal(s.quarantined, false);
});

test("quarantine: set + read", () => {
  const db = freshDb();
  setQuarantine(db, "agent-y", 10, "test");
  const s = getQuarantineState(db, "agent-y");
  assert.equal(s.quarantined, true);
  assert.equal(s.reason, "test");
  assert.ok(s.until);
  // window should be ~10 minutes in the future
  const ms = new Date(s.until!).getTime() - Date.now();
  assert.ok(ms > 9 * 60_000 && ms < 11 * 60_000, `window ${ms}ms not ~10min`);
});

test("quarantine: expired -> not quarantined", () => {
  const db = freshDb();
  // Manually insert an expired row
  db.prepare(
    `INSERT INTO agent_state (agent, quarantined_until, quarantine_reason, quarantined_at)
     VALUES ('z','2000-01-01T00:00:00Z','old','2000-01-01T00:00:00Z')`,
  ).run();
  const s = getQuarantineState(db, "z");
  assert.equal(s.quarantined, false);
});

test("quarantine: clearQuarantine releases", () => {
  const db = freshDb();
  setQuarantine(db, "agent-y", 10, "test");
  assert.equal(getQuarantineState(db, "agent-y").quarantined, true);
  assert.equal(clearQuarantine(db, "agent-y"), true);
  assert.equal(getQuarantineState(db, "agent-y").quarantined, false);
});

test("quarantine: clearQuarantine on unknown agent returns false", () => {
  const db = freshDb();
  assert.equal(clearQuarantine(db, "never-seen"), false);
});
