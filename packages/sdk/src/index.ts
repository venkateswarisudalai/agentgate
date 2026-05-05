export type ApprovalRequest = {
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  sessionId?: string;
};

export type Session = {
  id: string;
  agent: string;
  status: "active" | "ended";
  metadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
};

export type IssuedCredential = {
  credentialId: string;
  token: string;
  expiresAt: string;
  agent: string;
  action: string;
};

export type CredentialVerification =
  | {
      valid: true;
      credentialId: string;
      agent: string;
      action: string;
      remainingUses: number;
      expiresAt: string;
      scope: unknown;
    }
  | {
      valid: false;
      code: string;
      error: string;
    };

export type Decision = {
  id: string;
  approved: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  /** Original reason supplied by the agent when requesting approval. */
  reason: string;
  /** Note from the human approver/denier, if they provided one. */
  decisionReason: string | null;
};

export type AgentGateOptions = {
  baseUrl: string;
  agent: string;
  apiKey?: string;
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
};

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ApprovalTimeoutError extends Error {
  constructor(public readonly approvalId: string) {
    super(`Approval ${approvalId} timed out`);
    this.name = "ApprovalTimeoutError";
  }
}

export class AgentGate {
  private readonly baseUrl: string;
  private readonly agent: string;
  private readonly apiKey?: string;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(opts: AgentGateOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.agent = opts.agent;
    this.apiKey = opts.apiKey;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async requireApproval(req: ApprovalRequest): Promise<Decision> {
    const created = await this.createApproval(req);
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    return this.waitForDecision(created.id, timeoutMs);
  }

  async beginSession(metadata?: Record<string, unknown>): Promise<Session> {
    const res = await this.fetch("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: this.agent, metadata: metadata ?? {} }),
    });
    if (!res.ok) {
      throw new Error(`Failed to begin session: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Session;
  }

  async issueCredential(input: {
    approvalId: string;
    scope?: unknown;
    ttlSeconds?: number;
    maxUses?: number;
  }): Promise<IssuedCredential> {
    const res = await this.fetch("/v1/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Failed to issue credential: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as IssuedCredential;
  }

  async verifyCredential(input: {
    token: string;
    action?: string;
    agent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CredentialVerification> {
    const res = await this.fetch("/v1/credentials/verify", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return (await res.json()) as CredentialVerification;
  }

  async revokeCredential(credentialId: string, reason?: string): Promise<void> {
    const res = await this.fetch(`/v1/credentials/${credentialId}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      throw new Error(`Failed to revoke credential: ${res.status} ${await res.text()}`);
    }
  }

  async endSession(sessionId: string): Promise<Session> {
    const res = await this.fetch(`/v1/sessions/${sessionId}/end`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Failed to end session: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Session;
  }

  private async createApproval(req: ApprovalRequest): Promise<{ id: string }> {
    const res = await this.fetch("/v1/approvals", {
      method: "POST",
      body: JSON.stringify({
        agent: this.agent,
        action: req.action,
        reason: req.reason,
        metadata: req.metadata ?? {},
        sessionId: req.sessionId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create approval: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { id: string };
  }

  private async waitForDecision(id: string, timeoutMs: number): Promise<Decision> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const decision = await this.getDecision(id);
      if (decision.decidedAt) return decision;
      await sleep(this.pollIntervalMs);
    }
    throw new ApprovalTimeoutError(id);
  }

  private async getDecision(id: string): Promise<Decision> {
    const res = await this.fetch(`/v1/approvals/${id}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch approval: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Decision;
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
