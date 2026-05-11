import test from "node:test";
import assert from "node:assert/strict";

// Force NO_COLOR so render output is plain text and easy to assert.
process.env.NO_COLOR = "1";

// Import after setting env so the color helpers pick it up.
const { renderShortLine, renderApprovalCard, renderTable } = await import(
  "../src/render.ts"
);
import type { Approval } from "../src/api.ts";

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "abcdef1234567890",
    agent: "ml-bot",
    action: "drop-table",
    reason: "cleanup orphan rows",
    metadata: {
      ruleId: "iac.drop_table",
      category: "iac",
      severity: "high",
      impact: {
        headline: "Will drop table 'users' (1.2M rows)",
        consequences: ["Irreversible without backup", "Affects prod"],
        recoverable: "no",
        targets: { table: "users", env: "prod" },
      },
      toolInput: { command: "DROP TABLE users" },
    },
    status: "pending",
    approved: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: "2026-05-11T10:30:00",
    ...over,
  };
}

test("renderShortLine: includes id prefix, agent, severity, category, headline", () => {
  const line = renderShortLine(makeApproval());
  assert.ok(line.includes("abcdef12"), "id prefix");
  assert.ok(line.includes("ml-bot"), "agent");
  assert.ok(line.includes("high"), "severity");
  assert.ok(line.includes("iac"), "category");
  assert.ok(line.includes("Will drop table 'users' (1.2M rows)"), "headline");
});

test("renderShortLine: pending status shows hourglass", () => {
  const line = renderShortLine(makeApproval({ status: "pending" }));
  assert.ok(line.includes("⏳"));
});

test("renderShortLine: approved status shows checkmark", () => {
  const line = renderShortLine(makeApproval({ status: "approved", approved: true }));
  assert.ok(line.includes("✓"));
});

test("renderShortLine: denied status shows X", () => {
  const line = renderShortLine(makeApproval({ status: "denied" }));
  assert.ok(line.includes("✗"));
});

test("renderShortLine: falls back to reason when no impact.headline", () => {
  const a = makeApproval();
  a.metadata.impact = undefined;
  const line = renderShortLine(a);
  assert.ok(line.includes("cleanup orphan rows"));
});

test("renderShortLine: handles missing severity/category gracefully", () => {
  const line = renderShortLine(
    makeApproval({
      metadata: { impact: { headline: "x" } },
    }),
  );
  assert.ok(line.includes("?"), "shows ? placeholder for missing fields");
});

// ---------- renderApprovalCard ----------

test("renderApprovalCard: includes severity tag, headline, consequences, targets", () => {
  const card = renderApprovalCard(makeApproval());
  assert.ok(card.includes("[HIGH]"));
  assert.ok(card.includes("Will drop table 'users' (1.2M rows)"));
  assert.ok(card.includes("Irreversible without backup"));
  assert.ok(card.includes("Affects prod"));
  assert.ok(card.includes("recoverable: no"));
  assert.ok(card.includes("table=users"));
  assert.ok(card.includes("env=prod"));
  assert.ok(card.includes("ml-bot"));
  assert.ok(card.includes("drop-table"));
});

test("renderApprovalCard: shows command from toolInput", () => {
  const card = renderApprovalCard(makeApproval());
  assert.ok(card.includes("DROP TABLE users"));
});

test("renderApprovalCard: shows file_path when no command", () => {
  const card = renderApprovalCard(
    makeApproval({
      metadata: {
        severity: "medium",
        category: "fs",
        impact: { headline: "Write to /etc/hosts" },
        toolInput: { file_path: "/etc/hosts" },
      },
    }),
  );
  assert.ok(card.includes("/etc/hosts"));
});

test("renderApprovalCard: omits targets line when no targets", () => {
  const card = renderApprovalCard(
    makeApproval({
      metadata: {
        severity: "low",
        impact: { headline: "trivial" },
      },
    }),
  );
  assert.ok(!card.includes("targets:"));
});

// ---------- renderTable ----------

test("renderTable: empty list shows '(no approvals)'", () => {
  assert.equal(renderTable([]), "(no approvals)");
});

test("renderTable: joins multiple rows with newlines", () => {
  const out = renderTable([
    makeApproval({ id: "id00001-aaa" }),
    makeApproval({ id: "id00002-bbb" }),
  ]);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("id00001"));
  assert.ok(lines[1].includes("id00002"));
});
