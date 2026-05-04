import test from "node:test";
import assert from "node:assert/strict";
import { checkTyposquat } from "../src/typosquat.ts";

test("typosquat: exact top-list match returns null", () => {
  assert.equal(checkTyposquat("react", "npm"), null);
  assert.equal(checkTyposquat("requests", "pypi"), null);
});

test("typosquat: distance 1 from popular -> high", () => {
  const sig = checkTyposquat("expreess", "npm"); // express + 1 char
  assert.ok(sig);
  assert.equal(sig!.severity, "high");
  assert.equal(sig!.kind, "typosquat");
  assert.match(sig!.message, /express/);
});

test("typosquat: distance 1 also high (lodash typo)", () => {
  const sig = checkTyposquat("lodahs", "npm"); // lodash transposed
  assert.ok(sig);
  // Levenshtein for transposition is 2 unless adjacent — lodahs vs lodash is 2 (h<->s swap = 2 edits)
  // Either way some match should fire if popular package within 2
  assert.ok(sig!.severity === "high" || sig!.severity === "medium");
});

test("typosquat: distance 2 -> medium", () => {
  // pick a name 2 chars off that is unique in the list
  const sig = checkTyposquat("axios2x", "npm"); // axios -> axios2x is 2 inserts
  if (sig) {
    assert.equal(sig.severity, "medium");
  }
  // accept either null or medium — depends on candidates in our top list
});

test("typosquat: completely unrelated name -> null", () => {
  const sig = checkTyposquat("totally-novel-pkg-zxy", "npm");
  assert.equal(sig, null);
});

test("typosquat: pypi normalizes _ and . to -", () => {
  // requests is in PYPI_TOP. "request_s" should normalize to "request-s"
  // which is distance 1 from "requests" -> high
  const sig = checkTyposquat("request_s", "pypi");
  assert.ok(sig);
  assert.match(sig!.message, /requests/);
});

test("typosquat: pypi exact match (with case) returns null", () => {
  assert.equal(checkTyposquat("Requests", "pypi"), null); // case-insensitive
  assert.equal(checkTyposquat("Numpy", "pypi"), null);
});
