export type Approval = {
  id: string;
  agent: string;
  action: string;
  reason: string;
  metadata: {
    ruleId?: string;
    category?: string;
    severity?: string;
    impact?: {
      headline?: string;
      consequences?: string[];
      recoverable?: string;
      targets?: Record<string, string>;
    };
    toolInput?: Record<string, unknown>;
    [k: string]: unknown;
  };
  status: "pending" | "approved" | "denied";
  approved: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
};

export type AuditEntry = {
  id: number;
  approvalId: string;
  event: string;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export class Api {
  constructor(public readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async list(status?: string, limit = 100): Promise<Approval[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("limit", String(limit));
    return this.json<Approval[]>(`/v1/approvals?${params}`);
  }

  async get(id: string): Promise<Approval> {
    return this.json<Approval>(`/v1/approvals/${id}`);
  }

  async decide(id: string, approved: boolean, decidedBy: string, reason?: string) {
    return this.json<Approval>(`/v1/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ approved, decidedBy, reason }),
    });
  }

  async audit(): Promise<AuditEntry[]> {
    return this.json<AuditEntry[]>(`/v1/audit`);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
    });
    if (!res.ok) throw new ApiError(`${init.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`, res.status);
    return (await res.json()) as T;
  }
}

// Minimal SSE client. Yields parsed JSON events from the control plane.
export async function* streamEvents(baseUrl: string, signal?: AbortSignal): AsyncGenerator<unknown, void, void> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/events`, { signal });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = line.match(/^data:\s*(.*)$/);
        if (m) {
          try { yield JSON.parse(m[1]); } catch { /* ignore non-json data lines */ }
        }
      }
    }
  }
}
