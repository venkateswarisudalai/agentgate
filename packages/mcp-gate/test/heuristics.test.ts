import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/heuristics.ts";

// ---------- verb-based classification ----------

test("classify: destructive verb in tool name -> high", () => {
  const d = classify("deleteUser", { id: "u1" });
  assert.equal(d.risk, "high");
  assert.equal(d.recoverable, "no");
  assert.match(d.headline, /HIGH risk/);
  assert.ok(d.reasons.some((r) => /destruction/.test(r)));
});

test("classify: destructive verb works across separators and camelCase", () => {
  for (const name of ["delete_user", "user.dropTable", "purgeCache", "remove-thing"]) {
    const d = classify(name, {});
    assert.equal(d.risk, "high", `expected high for ${name}`);
  }
});

test("classify: ALL-CAPS verb is currently NOT detected (known limitation)", () => {
  // lcWords splits ALL-CAPS words letter-by-letter, so "DELETE-user" is not
  // recognized as containing the verb "delete". Tracked as a real gap —
  // when fixed, change this assertion to "high".
  const d = classify("DELETE-user", {});
  assert.notEqual(d.risk, "high");
});

test("classify: mutation verb -> medium", () => {
  const d = classify("updateRecord", { id: "1" });
  assert.equal(d.risk, "medium");
  assert.equal(d.recoverable, "partial");
  assert.ok(d.reasons.some((r) => /mutation/.test(r)));
});

test("classify: safe verb -> low", () => {
  const d = classify("listUsers", {});
  assert.equal(d.risk, "low");
  assert.equal(d.recoverable, "yes");
  assert.deepEqual(d.reasons, []);
});

test("classify: unknown verb is treated as mutation (medium)", () => {
  const d = classify("frobnicate", {});
  assert.equal(d.risk, "medium");
  assert.ok(d.reasons.some((r) => /unknown verb/.test(r)));
});

// ---------- dangerous arg keys ----------

test("classify: dangerous arg=true escalates safe verb to high", () => {
  const d = classify("getThing", { force: true });
  assert.equal(d.risk, "high");
  assert.ok(d.reasons.some((r) => /dangerous arg: force/.test(r)));
});

test("classify: dangerous arg='true' string also escalates", () => {
  const d = classify("getThing", { cascade: "true" });
  assert.equal(d.risk, "high");
});

test("classify: dangerous arg=false does NOT escalate", () => {
  const d = classify("listThings", { force: false });
  assert.equal(d.risk, "low");
});

test("classify: privileged arg (admin=true) -> high", () => {
  const d = classify("getThing", { admin: true });
  assert.equal(d.risk, "high");
  assert.ok(d.reasons.some((r) => /privileged arg/.test(r)));
});

// ---------- dangerous values ----------

test("classify: prod reference in string arg bumps low to medium", () => {
  const d = classify("listThings", { env: "production" });
  assert.equal(d.risk, "medium");
  assert.ok(d.reasons.some((r) => /references prod/.test(r)));
});

test("classify: system path bumps low to medium", () => {
  const d = classify("readThing", { path: "/etc/passwd" });
  assert.equal(d.risk, "medium");
  assert.ok(d.reasons.some((r) => /system path/.test(r)));
});

test("classify: large number bumps low to medium", () => {
  const d = classify("setLimit", { count: 50000 });
  // setLimit -> "set" is a mutation verb -> already medium
  assert.equal(d.risk, "medium");
  const d2 = classify("getThing", { count: 50000 });
  assert.equal(d2.risk, "medium");
  assert.ok(d2.reasons.some((r) => /large number/.test(r)));
});

test("classify: dangerous value does NOT downgrade medium to low", () => {
  const d = classify("updateRecord", { env: "production" });
  assert.equal(d.risk, "medium");
});

test("classify: dangerous value does NOT downgrade high", () => {
  const d = classify("deleteRecord", { env: "production" });
  assert.equal(d.risk, "high");
});

// ---------- output shape ----------

test("classify: high risk consequences include destruction language", () => {
  const d = classify("deleteUser", {});
  assert.ok(d.consequences.length > 0);
  assert.ok(d.consequences.some((c) => /destructive|irreversible/.test(c)));
});

test("classify: low risk consequences mention read-only", () => {
  const d = classify("getUser", {});
  assert.ok(d.consequences.some((c) => /read-only/.test(c)));
});

test("classify: headline includes tool name and risk tier", () => {
  const d = classify("publishRelease", {});
  assert.ok(d.headline.includes("publishRelease"));
  assert.ok(d.headline.includes("HIGH"));
});

// ---------- edge cases ----------

test("classify: empty args object is fine", () => {
  const d = classify("listThings", {});
  assert.equal(d.risk, "low");
});

test("classify: empty tool name -> unknown verb -> medium", () => {
  const d = classify("", {});
  assert.equal(d.risk, "medium");
});

test("classify: namespaced tool names parse correctly", () => {
  const d = classify("Stripe.refund", {});
  // "refund" is not in any list -> unknown verb -> medium
  assert.equal(d.risk, "medium");
  const d2 = classify("Stripe.delete", {});
  assert.equal(d2.risk, "high");
});
