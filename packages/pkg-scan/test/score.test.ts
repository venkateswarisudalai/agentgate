import test from "node:test";
import assert from "node:assert/strict";
import { deriveContextSignals, scoreRisk } from "../src/score.ts";
import type { ScanSignal } from "../src/types.ts";

// ---------- deriveContextSignals ----------

test("deriveContextSignals: empty meta -> no signals", () => {
  assert.deepEqual(deriveContextSignals({}), []);
});

test("deriveContextSignals: very new package (<7d) flagged high", () => {
  const out = deriveContextSignals({ ageDays: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "new_package");
  assert.equal(out[0].severity, "high");
});

test("deriveContextSignals: <30d but >=7d flagged medium", () => {
  const out = deriveContextSignals({ ageDays: 14 });
  assert.equal(out[0].kind, "new_package");
  assert.equal(out[0].severity, "medium");
});

test("deriveContextSignals: 30d+ does not flag new_package", () => {
  const out = deriveContextSignals({ ageDays: 90 });
  assert.equal(out.find((s) => s.kind === "new_package"), undefined);
});

test("deriveContextSignals: high-traffic package suppresses new_package", () => {
  // 5 day old package with 50M weekly downloads is just a routine patch
  const out = deriveContextSignals({ ageDays: 5, weeklyDownloads: 50_000_000 });
  assert.equal(out.find((s) => s.kind === "new_package"), undefined);
});

test("deriveContextSignals: low downloads flagged", () => {
  const lo = deriveContextSignals({ weeklyDownloads: 50 });
  assert.equal(lo[0].kind, "low_downloads");
  assert.equal(lo[0].severity, "medium"); // <100
  const med = deriveContextSignals({ weeklyDownloads: 500 });
  assert.equal(med[0].severity, "low"); // <1000 but >=100
});

test("deriveContextSignals: very high downloads not flagged as low", () => {
  const out = deriveContextSignals({ weeklyDownloads: 5_000_000 });
  assert.equal(out.find((s) => s.kind === "low_downloads"), undefined);
});

test("deriveContextSignals: sole maintainer flagged unless high-traffic", () => {
  const flagged = deriveContextSignals({ maintainers: 1, weeklyDownloads: 100 });
  assert.ok(flagged.some((s) => s.kind === "sole_maintainer"));
  const suppressed = deriveContextSignals({
    maintainers: 1,
    weeklyDownloads: 50_000_000,
  });
  assert.equal(suppressed.find((s) => s.kind === "sole_maintainer"), undefined);
});

test("deriveContextSignals: deprecated -> medium", () => {
  const out = deriveContextSignals({ deprecated: true });
  const sig = out.find((s) => s.kind === "deprecated");
  assert.ok(sig);
  assert.equal(sig!.severity, "medium");
});

test("deriveContextSignals: post-install scripts -> high", () => {
  const out = deriveContextSignals({
    hasInstallScripts: true,
    installScripts: { postinstall: "node scripts/install.js" },
  });
  const sig = out.find((s) => s.kind === "post_install_script");
  assert.ok(sig);
  assert.equal(sig!.severity, "high");
});

// ---------- scoreRisk ----------

test("scoreRisk: empty -> low", () => {
  assert.equal(scoreRisk([]), "low");
});

test("scoreRisk: critical CVE -> critical", () => {
  const sig: ScanSignal = { kind: "cve", severity: "critical", message: "x" };
  assert.equal(scoreRisk([sig]), "critical");
});

test("scoreRisk: high typosquat -> critical", () => {
  const sig: ScanSignal = { kind: "typosquat", severity: "high", message: "x" };
  assert.equal(scoreRisk([sig]), "critical");
});

test("scoreRisk: post_install + new_package -> critical", () => {
  const sigs: ScanSignal[] = [
    { kind: "post_install_script", severity: "high", message: "x" },
    { kind: "new_package", severity: "high", message: "x" },
  ];
  assert.equal(scoreRisk(sigs), "critical");
});

test("scoreRisk: high CVE alone -> high", () => {
  const sig: ScanSignal = { kind: "cve", severity: "high", message: "x" };
  assert.equal(scoreRisk([sig]), "high");
});

test("scoreRisk: lone medium signal -> medium", () => {
  const sig: ScanSignal = { kind: "deprecated", severity: "medium", message: "x" };
  assert.equal(scoreRisk([sig]), "medium");
});

test("scoreRisk: two medium+ signals -> at least medium", () => {
  const sigs: ScanSignal[] = [
    { kind: "deprecated", severity: "medium", message: "a" },
    { kind: "low_downloads", severity: "medium", message: "b" },
  ];
  assert.equal(scoreRisk(sigs), "medium");
});

test("scoreRisk: single low severity stays low", () => {
  const sig: ScanSignal = {
    kind: "sole_maintainer",
    severity: "low",
    message: "x",
  };
  assert.equal(scoreRisk([sig]), "low");
});
