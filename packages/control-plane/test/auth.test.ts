import test from "node:test";
import assert from "node:assert/strict";
import { loadAuthConfig, authenticate, isLoopbackHost, canApprove } from "../src/auth.ts";

test("loadAuthConfig: no env -> dev mode", () => {
  const cfg = loadAuthConfig({});
  assert.equal(cfg.configured, false);
  assert.equal(cfg.tokens.size, 0);
  assert.ok(cfg.devActor.startsWith("local:"));
});

test("loadAuthConfig: AGENTGATE_TOKEN -> operator token, team mode", () => {
  const cfg = loadAuthConfig({ AGENTGATE_TOKEN: "op", AGENTGATE_OPERATOR_ID: "alice@co" });
  assert.equal(cfg.configured, true);
  const p = authenticate(cfg, "Bearer op");
  assert.deepEqual(p, { id: "alice@co", role: "operator" });
});

test("loadAuthConfig: AGENTGATE_TOKENS JSON multi-user", () => {
  const cfg = loadAuthConfig({
    AGENTGATE_TOKENS: JSON.stringify([
      { id: "bot", role: "agent", token: "a" },
      { id: "carol", role: "admin", token: "b" },
    ]),
  });
  assert.equal(authenticate(cfg, "Bearer a")?.id, "bot");
  assert.equal(authenticate(cfg, "Bearer b")?.role, "admin");
});

test("loadAuthConfig: malformed AGENTGATE_TOKENS throws", () => {
  assert.throws(() => loadAuthConfig({ AGENTGATE_TOKENS: "not json" }));
  assert.throws(() =>
    loadAuthConfig({ AGENTGATE_TOKENS: JSON.stringify([{ id: "x", role: "bogus", token: "t" }]) }),
  );
});

test("authenticate: rejects missing / wrong / malformed bearer", () => {
  const cfg = loadAuthConfig({ AGENTGATE_TOKEN: "secret" });
  assert.equal(authenticate(cfg, undefined), null);
  assert.equal(authenticate(cfg, "Bearer wrong"), null);
  assert.equal(authenticate(cfg, "secret"), null); // no Bearer prefix
});

test("isLoopbackHost", () => {
  for (const h of ["127.0.0.1", "::1", "localhost", "127.5.5.5"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["0.0.0.0", "10.0.0.1", "192.168.1.4"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("canApprove: only operator/admin", () => {
  assert.equal(canApprove({ id: "a", role: "operator" }), true);
  assert.equal(canApprove({ id: "a", role: "admin" }), true);
  assert.equal(canApprove({ id: "a", role: "agent" }), false);
});
