import test from "node:test";
import assert from "node:assert/strict";
import { shouldGate, parseMinRisk, isShadowMode } from "../src/gating.ts";

test("shouldGate: high-only default forwards medium MCP calls", () => {
  // save_issue / send_message / update_page classify as medium → should NOT gate
  assert.equal(shouldGate("medium", "high"), false);
  // delete / deploy classify as high → gate
  assert.equal(shouldGate("high", "high"), true);
});

test("parseMinRisk: --gate-medium lowers the floor", () => {
  assert.equal(parseMinRisk("medium", {}), "medium");
  assert.equal(parseMinRisk(undefined, {}), "high");
  assert.equal(parseMinRisk(undefined, { AGENTGATE_MIN_SEVERITY: "medium" }), "medium");
});

test("isShadowMode: flag or env", () => {
  assert.equal(isShadowMode(false, {}), false);
  assert.equal(isShadowMode(true, {}), true);
  assert.equal(isShadowMode(false, { AGENTGATE_SHADOW: "1" }), true);
});
