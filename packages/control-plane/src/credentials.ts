import type Database from "better-sqlite3";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ApprovalRow, CredentialRow } from "./db.js";
import { evalCondition } from "./policy.js";
import { appendAudit } from "./audit.js";

const SECRET_KEY = "credential.signing";

// Prefer an out-of-band signing secret (env / secrets manager) so the key that
// authenticates credentials does NOT live in the same SQLite file as the data
// it protects. The DB-stored secret remains a zero-config fallback for local
// dev; production deployments should set AGENTGATE_SIGNING_SECRET.
function getOrCreateSigningSecret(db: Database.Database): string {
  const fromEnv = (process.env.AGENTGATE_SIGNING_SECRET ?? "").trim();
  if (fromEnv) return fromEnv;
  const row = db
    .prepare(`SELECT value FROM secrets WHERE key = ?`)
    .get(SECRET_KEY) as { value: string } | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO secrets (key, value) VALUES (?, ?)`).run(SECRET_KEY, secret);
  return secret;
}

function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function b64uDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export type CredentialPayload = {
  jti: string;
  sub: string; // agent
  act: string; // action
  scope: unknown;
  iat: number; // unix seconds
  exp: number;
  aud: "agentgate";
};

function sign(payload: CredentialPayload, secret: string): string {
  const body = b64uEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySignature(token: string, secret: string): CredentialPayload | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, providedBuf)) return null;
  try {
    const payload = JSON.parse(b64uDecode(body).toString("utf8")) as CredentialPayload;
    if (payload.aud !== "agentgate") return null;
    return payload;
  } catch {
    return null;
  }
}

export type IssueInput = {
  approvalId: string;
  scope?: unknown; // policy-engine condition; defaults to true (no extra constraints beyond action)
  ttlSeconds?: number;
  maxUses?: number;
};

export type IssueResult = {
  credentialId: string;
  token: string;
  expiresAt: string;
  agent: string;
  action: string;
};

export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "approval_not_found"
      | "approval_not_approved"
      | "expired"
      | "revoked"
      | "exhausted"
      | "scope_violation"
      | "action_mismatch"
      | "bad_token"
      | "agent_mismatch",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const DEFAULT_MAX_USES = 1;

export function issueCredential(
  db: Database.Database,
  input: IssueInput,
): IssueResult {
  const approval = db
    .prepare(`SELECT * FROM approvals WHERE id = ?`)
    .get(input.approvalId) as ApprovalRow | undefined;
  if (!approval) {
    throw new CredentialError(`approval ${input.approvalId} not found`, "approval_not_found");
  }
  if (approval.status !== "approved") {
    throw new CredentialError(
      `approval ${input.approvalId} is ${approval.status}, not approved`,
      "approval_not_approved",
    );
  }

  const ttl = Math.max(1, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const maxUses = Math.max(1, Math.floor(input.maxUses ?? DEFAULT_MAX_USES));
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const expiresAt = new Date(exp * 1000).toISOString();
  const scope = input.scope ?? true;
  const scopeJson = JSON.stringify(scope);

  db.prepare(
    `INSERT INTO credentials
       (id, approval_id, agent, action, scope, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, approval.id, approval.agent, approval.action, scopeJson, maxUses, expiresAt);

  const secret = getOrCreateSigningSecret(db);
  const token = sign(
    {
      jti: id,
      sub: approval.agent,
      act: approval.action,
      scope,
      iat: now,
      exp,
      aud: "agentgate",
    },
    secret,
  );

  return { credentialId: id, token, expiresAt, agent: approval.agent, action: approval.action };
}

export type VerifyInput = {
  token: string;
  action?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
};

export type VerifyResult = {
  valid: true;
  credentialId: string;
  agent: string;
  action: string;
  remainingUses: number;
  expiresAt: string;
  scope: unknown;
};

export async function verifyCredential(
  db: Database.Database,
  input: VerifyInput,
): Promise<VerifyResult> {
  const secret = getOrCreateSigningSecret(db);
  const payload = verifySignature(input.token, secret);
  if (!payload) throw new CredentialError("invalid token signature", "bad_token");

  const row = db
    .prepare(`SELECT * FROM credentials WHERE id = ?`)
    .get(payload.jti) as CredentialRow | undefined;
  if (!row) throw new CredentialError("credential not found", "bad_token");

  if (row.revoked === 1) {
    throw new CredentialError(
      `credential revoked: ${row.revoked_reason ?? "(no reason)"}`,
      "revoked",
    );
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new CredentialError("credential expired", "expired");
  }
  if (row.use_count >= row.max_uses) {
    throw new CredentialError(
      `credential exhausted (${row.use_count}/${row.max_uses})`,
      "exhausted",
    );
  }

  if (input.action && input.action !== row.action) {
    throw new CredentialError(
      `action mismatch: token issued for ${row.action}, requested ${input.action}`,
      "action_mismatch",
    );
  }
  if (input.agent && input.agent !== row.agent) {
    throw new CredentialError(
      `agent mismatch: token issued for ${row.agent}, presented as ${input.agent}`,
      "agent_mismatch",
    );
  }

  // Scope check via the policy evaluator: the credential's stored scope is
  // evaluated as a condition against the request metadata. true = pass.
  let scope: unknown;
  try {
    scope = JSON.parse(row.scope);
  } catch {
    scope = true;
  }
  const metadata = input.metadata ?? {};
  const ok = await evalCondition(
    scope,
    { agent: row.agent, action: row.action, metadata, sessionId: null },
    db,
  );
  if (!ok) {
    throw new CredentialError(
      `scope violation: request metadata does not satisfy credential scope`,
      "scope_violation",
    );
  }

  // Increment use count + audit on success
  db.prepare(`UPDATE credentials SET use_count = use_count + 1 WHERE id = ?`).run(
    payload.jti,
  );
  appendAudit(db, {
    approvalId: row.approval_id,
    event: "credential.used",
    actor: `agent:${row.agent}`,
    payload: {
      credentialId: row.id,
      action: row.action,
      useCount: row.use_count + 1,
      maxUses: row.max_uses,
    },
  });

  return {
    valid: true,
    credentialId: row.id,
    agent: row.agent,
    action: row.action,
    remainingUses: row.max_uses - (row.use_count + 1),
    expiresAt: row.expires_at,
    scope,
  };
}

export function revokeCredential(
  db: Database.Database,
  credentialId: string,
  reason: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE credentials
       SET revoked = 1, revoked_at = datetime('now'), revoked_reason = ?
       WHERE id = ? AND revoked = 0`,
    )
    .run(reason, credentialId);
  if (result.changes === 0) return false;
  const row = db
    .prepare(`SELECT * FROM credentials WHERE id = ?`)
    .get(credentialId) as CredentialRow;
  appendAudit(db, {
    approvalId: row.approval_id,
    event: "credential.revoked",
    actor: "agentgate:control-plane",
    payload: { credentialId, reason },
  });
  return true;
}

export function getCredential(
  db: Database.Database,
  credentialId: string,
): CredentialRow | undefined {
  return db
    .prepare(`SELECT * FROM credentials WHERE id = ?`)
    .get(credentialId) as CredentialRow | undefined;
}
