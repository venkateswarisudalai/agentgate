import test from "node:test";
import assert from "node:assert/strict";
import { AgentGate, ApprovalTimeoutError } from "../src/index.ts";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withFetchStub(
  handler: (call: FetchCall, callIndex: number) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const idx = calls.length;
    calls.push({ url, init });
    return handler({ url, init }, idx);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------- constructor / baseUrl normalization ----------

test("constructor: trailing slash on baseUrl is stripped", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "a1" }));
  try {
    const gate = new AgentGate({ baseUrl: "http://localhost:4000/", agent: "test" });
    await gate.beginSession();
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "http://localhost:4000/v1/sessions");
  } finally {
    stub.restore();
  }
});

test("constructor: baseUrl without trailing slash is unchanged", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "a1" }));
  try {
    const gate = new AgentGate({ baseUrl: "http://localhost:4000", agent: "test" });
    await gate.beginSession();
    assert.equal(stub.calls[0].url, "http://localhost:4000/v1/sessions");
  } finally {
    stub.restore();
  }
});

// ---------- ApprovalTimeoutError ----------

test("ApprovalTimeoutError: carries the approval id and message", () => {
  const err = new ApprovalTimeoutError("approval-123");
  assert.equal(err.approvalId, "approval-123");
  assert.equal(err.name, "ApprovalTimeoutError");
  assert.match(err.message, /approval-123/);
  assert.match(err.message, /timed out/);
  assert.ok(err instanceof Error);
});

// ---------- requireApproval happy path ----------

test("requireApproval: returns decision once decidedAt is set", async () => {
  const stub = withFetchStub((call, idx) => {
    if (idx === 0) {
      // POST /v1/approvals
      assert.equal(call.init.method, "POST");
      return jsonResponse({ id: "ap1" });
    }
    // GET /v1/approvals/ap1
    return jsonResponse({
      id: "ap1",
      approved: true,
      decidedBy: "venka",
      decidedAt: "2026-05-11T00:00:00",
      reason: "deploy",
      decisionReason: "looks fine",
    });
  });
  try {
    const gate = new AgentGate({
      baseUrl: "http://x",
      agent: "test",
      pollIntervalMs: 5,
    });
    const decision = await gate.requireApproval({ action: "deploy", reason: "deploy" });
    assert.equal(decision.id, "ap1");
    assert.equal(decision.approved, true);
    assert.equal(decision.decidedBy, "venka");
  } finally {
    stub.restore();
  }
});

test("requireApproval: posts agent, action, reason in the body", async () => {
  const stub = withFetchStub((_call, idx) => {
    if (idx === 0) return jsonResponse({ id: "ap1" });
    return jsonResponse({
      id: "ap1",
      approved: true,
      decidedBy: "human",
      decidedAt: "now",
      reason: "test",
      decisionReason: null,
    });
  });
  try {
    const gate = new AgentGate({
      baseUrl: "http://x",
      agent: "ml-agent",
      pollIntervalMs: 5,
    });
    await gate.requireApproval({ action: "drop-table", reason: "cleanup" });
    const createBody = JSON.parse(stub.calls[0].init.body as string);
    assert.equal(createBody.agent, "ml-agent");
    assert.equal(createBody.action, "drop-table");
    assert.equal(createBody.reason, "cleanup");
    assert.deepEqual(createBody.metadata, {});
  } finally {
    stub.restore();
  }
});

// ---------- requireApproval timeout ----------

test("requireApproval: throws ApprovalTimeoutError if no decision within timeout", async () => {
  const stub = withFetchStub((_call, idx) => {
    if (idx === 0) return jsonResponse({ id: "stuck" });
    return jsonResponse({
      id: "stuck",
      approved: false,
      decidedBy: null,
      decidedAt: null,
      reason: "deploy",
      decisionReason: null,
    });
  });
  try {
    const gate = new AgentGate({
      baseUrl: "http://x",
      agent: "test",
      pollIntervalMs: 5,
    });
    await assert.rejects(
      () =>
        gate.requireApproval({
          action: "x",
          reason: "y",
          timeoutMs: 30,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalTimeoutError);
        assert.equal((err as ApprovalTimeoutError).approvalId, "stuck");
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

// ---------- auth header ----------

test("fetch: apiKey is sent as Bearer token", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "s1" }));
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test", apiKey: "secret-123" });
    await gate.beginSession();
    const headers = stub.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer secret-123");
  } finally {
    stub.restore();
  }
});

test("fetch: no Authorization header when apiKey is absent", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "s1" }));
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test" });
    await gate.beginSession();
    const headers = stub.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["content-type"], "application/json");
  } finally {
    stub.restore();
  }
});

// ---------- error paths ----------

test("beginSession: throws on non-2xx", async () => {
  const stub = withFetchStub(
    () => new Response("nope", { status: 500 }),
  );
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test" });
    await assert.rejects(() => gate.beginSession(), /Failed to begin session: 500/);
  } finally {
    stub.restore();
  }
});

test("issueCredential: posts approvalId/scope/ttlSeconds/maxUses", async () => {
  const stub = withFetchStub(() =>
    jsonResponse({
      credentialId: "c1",
      token: "t1",
      expiresAt: "2026-12-31",
      agent: "test",
      action: "x",
    }),
  );
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test" });
    const cred = await gate.issueCredential({
      approvalId: "ap1",
      scope: { resource: "users" },
      ttlSeconds: 600,
      maxUses: 3,
    });
    assert.equal(cred.credentialId, "c1");
    assert.equal(stub.calls[0].url, "http://x/v1/credentials");
    const body = JSON.parse(stub.calls[0].init.body as string);
    assert.deepEqual(body, {
      approvalId: "ap1",
      scope: { resource: "users" },
      ttlSeconds: 600,
      maxUses: 3,
    });
  } finally {
    stub.restore();
  }
});

test("verifyCredential: returns server response as-is for invalid tokens", async () => {
  const stub = withFetchStub(() =>
    new Response(JSON.stringify({ valid: false, code: "expired", error: "token expired" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test" });
    const v = await gate.verifyCredential({ token: "abc" });
    assert.equal(v.valid, false);
    if (!v.valid) {
      assert.equal(v.code, "expired");
    }
  } finally {
    stub.restore();
  }
});

test("revokeCredential: throws on non-2xx", async () => {
  const stub = withFetchStub(() => new Response("forbidden", { status: 403 }));
  try {
    const gate = new AgentGate({ baseUrl: "http://x", agent: "test" });
    await assert.rejects(() => gate.revokeCredential("c1"), /403/);
  } finally {
    stub.restore();
  }
});
