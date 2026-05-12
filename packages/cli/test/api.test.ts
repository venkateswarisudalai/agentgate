import test from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, streamEvents } from "../src/api.ts";

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

// ---------- Api ----------

test("Api: trailing slash on baseUrl is stripped", () => {
  const api = new Api("http://localhost:4000/");
  assert.equal(api.baseUrl, "http://localhost:4000");
});

test("Api.list: hits /v1/approvals with limit query", async () => {
  const stub = withFetchStub(() => jsonResponse([]));
  try {
    const api = new Api("http://x");
    await api.list();
    assert.equal(stub.calls[0].url, "http://x/v1/approvals?limit=100");
  } finally {
    stub.restore();
  }
});

test("Api.list: includes status filter when provided", async () => {
  const stub = withFetchStub(() => jsonResponse([]));
  try {
    const api = new Api("http://x");
    await api.list("pending", 25);
    assert.equal(stub.calls[0].url, "http://x/v1/approvals?status=pending&limit=25");
  } finally {
    stub.restore();
  }
});

test("Api.get: fetches by id", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "ap1" }));
  try {
    const api = new Api("http://x");
    const out = await api.get("ap1");
    assert.equal(stub.calls[0].url, "http://x/v1/approvals/ap1");
    assert.equal(out.id, "ap1");
  } finally {
    stub.restore();
  }
});

test("Api.decide: POSTs approved/decidedBy/reason", async () => {
  const stub = withFetchStub(() => jsonResponse({ id: "ap1", approved: true }));
  try {
    const api = new Api("http://x");
    await api.decide("ap1", true, "venka", "looks fine");
    assert.equal(stub.calls[0].url, "http://x/v1/approvals/ap1/decide");
    assert.equal(stub.calls[0].init.method, "POST");
    const body = JSON.parse(stub.calls[0].init.body as string);
    assert.deepEqual(body, { approved: true, decidedBy: "venka", reason: "looks fine" });
  } finally {
    stub.restore();
  }
});

test("Api: throws ApiError on non-2xx, carries status", async () => {
  const stub = withFetchStub(() => new Response("nope", { status: 404 }));
  try {
    const api = new Api("http://x");
    await assert.rejects(
      () => api.get("missing"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 404);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test("Api.health: true on 2xx", async () => {
  const stub = withFetchStub(() => new Response("ok", { status: 200 }));
  try {
    const api = new Api("http://x");
    assert.equal(await api.health(), true);
    assert.equal(stub.calls[0].url, "http://x/healthz");
  } finally {
    stub.restore();
  }
});

test("Api.health: false on network failure (does not throw)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    const api = new Api("http://x");
    assert.equal(await api.health(), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("Api.health: false on non-2xx", async () => {
  const stub = withFetchStub(() => new Response("bad", { status: 503 }));
  try {
    const api = new Api("http://x");
    assert.equal(await api.health(), false);
  } finally {
    stub.restore();
  }
});

// ---------- streamEvents (SSE parsing) ----------

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

test("streamEvents: yields parsed JSON from a single SSE event", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(makeSseStream([`data: {"type":"hello","n":1}\n\n`]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const events: unknown[] = [];
    for await (const ev of streamEvents("http://x")) events.push(ev);
    assert.deepEqual(events, [{ type: "hello", n: 1 }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("streamEvents: handles multiple events and chunk-split frames", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      makeSseStream([
        `data: {"a":1}\n\nda`,
        `ta: {"b":2}\n\n`,
        `data: {"c":3}\n\n`,
      ]),
      { status: 200 },
    )) as typeof fetch;
  try {
    const events: unknown[] = [];
    for await (const ev of streamEvents("http://x")) events.push(ev);
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("streamEvents: skips non-JSON data lines without crashing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      makeSseStream([`data: not-json\n\ndata: {"ok":true}\n\n`]),
      { status: 200 },
    )) as typeof fetch;
  try {
    const events: unknown[] = [];
    for await (const ev of streamEvents("http://x")) events.push(ev);
    assert.deepEqual(events, [{ ok: true }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("streamEvents: throws if connect fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of streamEvents("http://x")) {
        // unreachable
      }
    }, /SSE connect failed: 500/);
  } finally {
    globalThis.fetch = original;
  }
});
