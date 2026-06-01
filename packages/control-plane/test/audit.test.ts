import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { appendAudit, verifyAuditChain, redact } from "../src/audit.ts";

let counter = 0;
function tmpDb() {
  const path = `/tmp/agentgate-audit-${process.pid}-${Date.now()}-${counter++}.db`;
  return openDb(path);
}

test("appendAudit: chain verifies across many entries", () => {
  const db = tmpDb();
  try {
    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, status) VALUES ('a','x','y','z','pending')`,
    ).run();
    for (let i = 0; i < 5; i++) {
      appendAudit(db, { approvalId: "a", event: `e${i}`, actor: "tester", payload: { i } });
    }
    const v = verifyAuditChain(db);
    assert.equal(v.ok, true);
    assert.equal(v.length, 5);
    assert.equal(v.brokenAt, null);
  } finally {
    db.close();
  }
});

test("verifyAuditChain: detects an edited payload", () => {
  const db = tmpDb();
  try {
    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, status) VALUES ('a','x','y','z','pending')`,
    ).run();
    appendAudit(db, { approvalId: "a", event: "e0", actor: "t", payload: { ok: true } });
    appendAudit(db, { approvalId: "a", event: "e1", actor: "t", payload: { ok: true } });
    appendAudit(db, { approvalId: "a", event: "e2", actor: "t", payload: { ok: true } });

    // Tamper: rewrite the payload of the middle row, bypassing appendAudit.
    const mid = db
      .prepare(`SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1`)
      .get() as { id: number };
    db.prepare(`UPDATE audit_log SET payload = ? WHERE id = ?`).run(
      JSON.stringify({ ok: false, tampered: true }),
      mid.id,
    );

    const v = verifyAuditChain(db);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, mid.id);
  } finally {
    db.close();
  }
});

test("verifyAuditChain: detects a deleted row", () => {
  const db = tmpDb();
  try {
    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, status) VALUES ('a','x','y','z','pending')`,
    ).run();
    appendAudit(db, { approvalId: "a", event: "e0", actor: "t", payload: {} });
    appendAudit(db, { approvalId: "a", event: "e1", actor: "t", payload: {} });
    appendAudit(db, { approvalId: "a", event: "e2", actor: "t", payload: {} });
    const first = db
      .prepare(`SELECT id FROM audit_log ORDER BY id ASC LIMIT 1`)
      .get() as { id: number };
    db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(first.id);
    assert.equal(verifyAuditChain(db).ok, false);
  } finally {
    db.close();
  }
});

test("appendAudit: redacts secrets before persisting", () => {
  const db = tmpDb();
  try {
    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, status) VALUES ('a','x','y','z','pending')`,
    ).run();
    appendAudit(db, {
      approvalId: "a",
      event: "e",
      actor: "t",
      payload: {
        password: "hunter2",
        api_key: "sk-abcdefghijklmnop1234",
        toolInput: { command: "deploy --token ghp_0123456789abcdefghij0123" },
        keep: "visible",
      },
    });
    const row = db.prepare(`SELECT payload FROM audit_log LIMIT 1`).get() as {
      payload: string;
    };
    assert.ok(!row.payload.includes("hunter2"));
    assert.ok(!row.payload.includes("ghp_0123456789abcdefghij0123"));
    assert.ok(row.payload.includes("visible"));
  } finally {
    db.close();
  }
});

test("redact: pure, leaves clean data untouched", () => {
  const input = { amount: 5, nested: { ok: [1, 2, 3] }, note: "fine" };
  assert.deepEqual(redact(input), input);
  // Connection-string password is scrubbed but host/user survive.
  const s = redact("postgres://user:s3cret@db.host/app") as string;
  assert.ok(!s.includes("s3cret"));
  assert.ok(s.includes("db.host"));
});
