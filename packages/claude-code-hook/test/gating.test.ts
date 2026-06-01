import test from "node:test";
import assert from "node:assert/strict";
import { severityRank, shouldGate, parseMinSeverity, isShadowMode } from "../src/gating.ts";

test("severityRank orders correctly", () => {
  assert.ok(severityRank("low") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("critical"));
});

test("shouldGate: default high floor lets medium through, gates high", () => {
  assert.equal(shouldGate("medium", "high"), false);
  assert.equal(shouldGate("high", "high"), true);
  assert.equal(shouldGate("critical", "high"), true);
});

test("shouldGate: opt-in medium floor gates medium", () => {
  assert.equal(shouldGate("medium", "medium"), true);
  assert.equal(shouldGate("low", "medium"), false);
});

test("parseMinSeverity: defaults to high, validates input", () => {
  assert.equal(parseMinSeverity({}), "high");
  assert.equal(parseMinSeverity({ AGENTGATE_MIN_SEVERITY: "medium" }), "medium");
  assert.equal(parseMinSeverity({ AGENTGATE_MIN_SEVERITY: "bogus" }), "high");
});

test("isShadowMode: opt-in via env", () => {
  assert.equal(isShadowMode({}), false);
  assert.equal(isShadowMode({ AGENTGATE_SHADOW: "1" }), true);
  assert.equal(isShadowMode({ AGENTGATE_SHADOW: "true" }), true);
});
