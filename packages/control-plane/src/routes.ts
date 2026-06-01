import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AgentStateRow,
  ApprovalRow,
  AuditRow,
  CredentialRow,
  PolicyEffect,
  PolicyRow,
  SessionRow,
  ShadowRow,
} from "./db.js";
import { bus } from "./events.js";
import {
  clearQuarantine,
  evalCondition,
  evaluatePolicies,
  getQuarantineState,
  parseCondition,
  PolicyConditionError,
  setQuarantine,
} from "./policy.js";
import {
  CredentialError,
  getCredential,
  issueCredential,
  revokeCredential,
  verifyCredential,
} from "./credentials.js";
import { appendAudit, redact, verifyAuditChain } from "./audit.js";
import {
  authenticate,
  canApprove,
  type AuthConfig,
  type Principal,
} from "./auth.js";

const DEV_AUTH: AuthConfig = {
  tokens: new Map(),
  configured: false,
  devActor: "local:dev",
};

function principalOf(req: { principal?: Principal }): Principal {
  // The onRequest hook always assigns this (dev principal when unauthenticated
  // and auth is not configured). The fallback keeps types honest.
  return req.principal ?? { id: "local:dev", role: "admin" };
}

type CreateBody = {
  agent: string;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

type DecideBody = {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
};

type PolicyBody = {
  name: string;
  description?: string;
  agentPattern?: string;
  actionPattern?: string;
  condition?: unknown;
  effect: PolicyEffect;
  priority?: number;
  enabled?: boolean;
  quarantineMinutes?: number;
};

type PolicyTestBody = {
  agent: string;
  action: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

type SessionCreateBody = {
  agent: string;
  metadata?: Record<string, unknown>;
};

type QuarantineBody = {
  minutes?: number;
  reason?: string;
};

type CredentialIssueBody = {
  approvalId: string;
  scope?: unknown;
  ttlSeconds?: number;
  maxUses?: number;
};

type CredentialVerifyBody = {
  token: string;
  action?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
};

type CredentialRevokeBody = {
  reason?: string;
};

function rowToCredential(row: CredentialRow) {
  let scope: unknown = true;
  try {
    scope = JSON.parse(row.scope);
  } catch {
    /* fall through */
  }
  return {
    id: row.id,
    approvalId: row.approval_id,
    agent: row.agent,
    action: row.action,
    scope,
    maxUses: row.max_uses,
    useCount: row.use_count,
    remainingUses: Math.max(0, row.max_uses - row.use_count),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    expired: new Date(row.expires_at).getTime() <= Date.now(),
    revoked: row.revoked === 1,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

const VALID_EFFECTS: readonly PolicyEffect[] = [
  "allow",
  "deny",
  "require_approval",
  "quarantine_agent",
];

function rowToPolicy(row: PolicyRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agentPattern: row.agent_pattern,
    actionPattern: row.action_pattern,
    condition: parseCondition(row.condition),
    effect: row.effect,
    priority: row.priority,
    enabled: row.enabled === 1,
    quarantineMinutes: row.quarantine_minutes ?? 60,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: SessionRow) {
  return {
    id: row.id,
    agent: row.agent,
    status: row.status,
    metadata: JSON.parse(row.metadata),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function rowToAgentState(row: AgentStateRow) {
  const quarantined =
    !!row.quarantined_until && new Date(row.quarantined_until).getTime() > Date.now();
  return {
    agent: row.agent,
    quarantined,
    quarantinedUntil: row.quarantined_until,
    quarantineReason: row.quarantine_reason,
    quarantinedAt: row.quarantined_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCondition(condition: unknown): string {
  if (condition === undefined || condition === null) return "true";
  if (typeof condition === "string") {
    const parsed = parseCondition(condition);
    return JSON.stringify(parsed);
  }
  return JSON.stringify(condition);
}

async function validateConditionShape(
  condition: unknown,
  db: Database.Database,
): Promise<string | null> {
  try {
    await evalCondition(
      condition,
      { agent: "_probe", action: "_probe", metadata: {} },
      db,
    );
    return null;
  } catch (err) {
    if (err instanceof PolicyConditionError) return err.message;
    return "invalid condition";
  }
}

function rowToDecision(row: ApprovalRow) {
  return {
    id: row.id,
    agent: row.agent,
    action: row.action,
    reason: row.reason,
    // Redact secrets/PII that may have ridden in on tool inputs before serving.
    metadata: redact(JSON.parse(row.metadata)),
    status: row.status,
    approved: row.status === "approved",
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    sessionId: row.session_id,
  };
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  auth: AuthConfig = DEV_AUTH,
): void {
  // ---------- auth ----------
  // Every /v1 request is authenticated. In TEAM MODE a valid bearer token is
  // required; in DEV MODE (no tokens configured, loopback-only bind enforced in
  // index.ts) requests are stamped with a single non-forgeable local identity.
  // /v1/events is exempt: it is a read-only SSE stream and browser EventSource
  // cannot send an Authorization header. Static assets and /healthz are not
  // under /v1 and pass through untouched.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/v1/")) return;
    if (path === "/v1/events") return;
    const principal = authenticate(auth, req.headers.authorization);
    if (auth.configured) {
      if (!principal) {
        return reply.code(401).send({ error: "missing or invalid bearer token" });
      }
      (req as { principal?: Principal }).principal = principal;
    } else {
      (req as { principal?: Principal }).principal = {
        id: auth.devActor,
        role: "admin",
      };
    }
  });

  // ---------- approvals ----------

  app.post<{ Body: CreateBody }>("/v1/approvals", async (req, reply) => {
    const { agent, action, reason, metadata, sessionId } =
      req.body ?? ({} as CreateBody);
    if (!agent || !action || !reason) {
      return reply.code(400).send({ error: "agent, action, and reason are required" });
    }

    if (sessionId) {
      const session = db
        .prepare(`SELECT id FROM sessions WHERE id = ?`)
        .get(sessionId) as { id: string } | undefined;
      if (!session) {
        return reply.code(400).send({ error: `unknown sessionId ${sessionId}` });
      }
    }

    const id = randomUUID();
    const meta = metadata ?? {};
    const metaJson = JSON.stringify(meta);

    // Pre-policy: hard-block requests for quarantined agents.
    const qState = getQuarantineState(db, agent);
    if (qState.quarantined) {
      const actor = "agentgate:quarantine";
      db.prepare(
        `INSERT INTO approvals
           (id, agent, action, reason, metadata, status, decided_by, decided_at, decision_reason, session_id)
         VALUES (?, ?, ?, ?, ?, 'denied', ?, datetime('now'), ?, ?)`,
      ).run(
        id,
        agent,
        action,
        reason,
        metaJson,
        actor,
        `agent quarantined until ${qState.until}: ${qState.reason ?? ""}`.trim(),
        sessionId ?? null,
      );
      appendAudit(db, { approvalId: id, event: "approval.created", actor: agent, payload: meta });
      appendAudit(db, {
        approvalId: id,
        event: "approval.quarantine_blocked",
        actor,
        payload: { until: qState.until, reason: qState.reason },
      });
      bus.emitEvent({ type: "approval.created", approvalId: id });
      bus.emitEvent({ type: "approval.decided", approvalId: id, status: "denied" });
      return reply.code(201).send({
        id,
        status: "denied",
        decidedBy: actor,
        quarantine: { until: qState.until, reason: qState.reason },
      });
    }

    const match = await evaluatePolicies(db, {
      agent,
      action,
      metadata: meta,
      sessionId: sessionId ?? null,
    });

    // quarantine_agent effect: set state, deny current, audit.
    if (match && match.effect === "quarantine_agent") {
      const minutes = match.quarantineMinutes ?? 60;
      const reasonText = `policy ${match.policyName} triggered auto-quarantine`;
      const until = setQuarantine(db, agent, minutes, reasonText);
      const actor = `policy:${match.policyName}`;
      db.prepare(
        `INSERT INTO approvals
           (id, agent, action, reason, metadata, status, decided_by, decided_at, decision_reason, session_id)
         VALUES (?, ?, ?, ?, ?, 'denied', ?, datetime('now'), ?, ?)`,
      ).run(id, agent, action, reason, metaJson, actor, reasonText, sessionId ?? null);
      appendAudit(db, { approvalId: id, event: "approval.created", actor: agent, payload: meta });
      appendAudit(db, {
        approvalId: id,
        event: "approval.auto_quarantined",
        actor,
        payload: {
          policyId: match.policyId,
          policyName: match.policyName,
          quarantineMinutes: minutes,
          quarantinedUntil: until,
        },
      });
      bus.emitEvent({ type: "approval.created", approvalId: id });
      bus.emitEvent({ type: "approval.decided", approvalId: id, status: "denied" });
      bus.emitEvent({ type: "agent.quarantined", agent, until });
      return reply.code(201).send({
        id,
        status: "denied",
        decidedBy: actor,
        quarantine: { until, minutes, reason: reasonText },
      });
    }

    const autoDecide =
      match && (match.effect === "allow" || match.effect === "deny") ? match : null;

    if (autoDecide) {
      const status = autoDecide.effect === "allow" ? "approved" : "denied";
      const actor = `policy:${autoDecide.policyName}`;
      db.prepare(
        `INSERT INTO approvals
           (id, agent, action, reason, metadata, status, decided_by, decided_at, decision_reason, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
      ).run(
        id,
        agent,
        action,
        reason,
        metaJson,
        status,
        actor,
        `auto-${status} by policy ${autoDecide.policyName}`,
        sessionId ?? null,
      );
      appendAudit(db, { approvalId: id, event: "approval.created", actor: agent, payload: meta });
      appendAudit(db, {
        approvalId: id,
        event: `approval.auto_${status}`,
        actor,
        payload: { policyId: autoDecide.policyId, policyName: autoDecide.policyName },
      });
      bus.emitEvent({ type: "approval.created", approvalId: id });
      bus.emitEvent({ type: "approval.decided", approvalId: id, status });
      return reply
        .code(201)
        .send({ id, status, decidedBy: actor, policy: autoDecide.policyName });
    }

    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, metadata, status, session_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, agent, action, reason, metaJson, sessionId ?? null);
    appendAudit(db, { approvalId: id, event: "approval.created", actor: agent, payload: meta });
    if (match && match.effect === "require_approval") {
      appendAudit(db, {
        approvalId: id,
        event: "approval.policy_matched",
        actor: `policy:${match.policyName}`,
        payload: { policyId: match.policyId, policyName: match.policyName },
      });
    }
    bus.emitEvent({ type: "approval.created", approvalId: id });
    return reply.code(201).send({ id, status: "pending" });
  });

  app.get<{ Params: { id: string } }>("/v1/approvals/:id", async (req, reply) => {
    const row = db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(req.params.id) as ApprovalRow | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    return rowToDecision(row);
  });

  app.get<{ Querystring: { status?: string; limit?: string; sessionId?: string } }>(
    "/v1/approvals",
    async (req) => {
      const status = req.query.status;
      const sessionId = req.query.sessionId;
      const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
      const conds: string[] = [];
      const params: unknown[] = [];
      if (status) {
        conds.push("status = ?");
        params.push(status);
      }
      if (sessionId) {
        conds.push("session_id = ?");
        params.push(sessionId);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = db
        .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as ApprovalRow[];
      return rows.map(rowToDecision);
    },
  );

  app.post<{ Params: { id: string }; Body: DecideBody }>(
    "/v1/approvals/:id/decide",
    async (req, reply) => {
      const { id } = req.params;
      const { approved, reason } = req.body ?? ({} as DecideBody);
      if (typeof approved !== "boolean") {
        return reply.code(400).send({ error: "approved (boolean) is required" });
      }
      // The approver's identity comes from the authenticated principal — never
      // from the request body. This is what makes "a human approved this" mean
      // something: you cannot stamp an approval with someone else's name.
      const principal = principalOf(req as { principal?: Principal });
      if (!canApprove(principal)) {
        return reply
          .code(403)
          .send({ error: "approver role required (operator or admin)" });
      }
      const row = db
        .prepare(`SELECT * FROM approvals WHERE id = ?`)
        .get(id) as ApprovalRow | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `already ${row.status}` });
      }
      // Separation of duties: the agent that requested an action cannot be the
      // identity that approves it.
      if (principal.id === row.agent) {
        return reply
          .code(403)
          .send({ error: "requester cannot approve their own request" });
      }
      const status = approved ? "approved" : "denied";
      const actor = principal.id;
      db.prepare(
        `UPDATE approvals
         SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
         WHERE id = ?`,
      ).run(status, actor, reason ?? null, id);
      appendAudit(db, {
        approvalId: id,
        event: `approval.${status}`,
        actor,
        payload: { reason },
      });
      bus.emitEvent({ type: "approval.decided", approvalId: id, status });
      const updated = db
        .prepare(`SELECT * FROM approvals WHERE id = ?`)
        .get(id) as ApprovalRow;
      return rowToDecision(updated);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/approvals/:id/audit", async (req, reply) => {
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE approval_id = ? ORDER BY id ASC`)
      .all(req.params.id) as AuditRow[];
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      actor: r.actor,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    }));
  });

  app.get("/v1/audit", async () => {
    const rows = db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 200`)
      .all() as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      approvalId: r.approval_id,
      event: r.event,
      actor: r.actor,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
    }));
  });

  // Recompute the whole audit hash chain. ok=false means a row was edited,
  // deleted, or reordered after it was written. This is the tamper-evidence
  // check — wire it into monitoring to detect log mutation.
  app.get("/v1/audit/verify", async () => {
    return verifyAuditChain(db);
  });

  // ---------- sessions ----------

  app.post<{ Body: SessionCreateBody }>("/v1/sessions", async (req, reply) => {
    const { agent, metadata } = req.body ?? ({} as SessionCreateBody);
    if (!agent) return reply.code(400).send({ error: "agent is required" });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, agent, status, metadata) VALUES (?, ?, 'active', ?)`,
    ).run(id, agent, JSON.stringify(metadata ?? {}));
    bus.emitEvent({ type: "session.started", sessionId: id, agent });
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow;
    return reply.code(201).send(rowToSession(row));
  });

  app.get<{ Params: { id: string } }>("/v1/sessions/:id", async (req, reply) => {
    const row = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(req.params.id) as SessionRow | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const approvals = db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(req.params.id) as ApprovalRow[];
    return { ...rowToSession(row), approvals: approvals.map(rowToDecision) };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/sessions/:id/end",
    async (req, reply) => {
      const result = db
        .prepare(
          `UPDATE sessions SET status = 'ended', ended_at = datetime('now')
           WHERE id = ? AND status = 'active'`,
        )
        .run(req.params.id);
      if (result.changes === 0) {
        return reply.code(404).send({ error: "session not found or already ended" });
      }
      const row = db
        .prepare(`SELECT * FROM sessions WHERE id = ?`)
        .get(req.params.id) as SessionRow;
      bus.emitEvent({ type: "session.ended", sessionId: row.id, agent: row.agent });
      return rowToSession(row);
    },
  );

  app.get<{ Querystring: { agent?: string; status?: string; limit?: string } }>(
    "/v1/sessions",
    async (req) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (req.query.agent) {
        conds.push("agent = ?");
        params.push(req.query.agent);
      }
      if (req.query.status) {
        conds.push("status = ?");
        params.push(req.query.status);
      }
      const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = db
        .prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`)
        .all(...params) as SessionRow[];
      return rows.map(rowToSession);
    },
  );

  // ---------- agent state / quarantine ----------

  app.get<{ Params: { agent: string } }>("/v1/agents/:agent", async (req) => {
    const row = db
      .prepare(`SELECT * FROM agent_state WHERE agent = ?`)
      .get(req.params.agent) as AgentStateRow | undefined;
    if (!row) {
      return {
        agent: req.params.agent,
        quarantined: false,
        quarantinedUntil: null,
        quarantineReason: null,
        quarantinedAt: null,
        updatedAt: null,
      };
    }
    return rowToAgentState(row);
  });

  app.post<{ Params: { agent: string }; Body: QuarantineBody }>(
    "/v1/agents/:agent/quarantine",
    async (req, reply) => {
      const minutes = Math.max(1, Math.floor(req.body?.minutes ?? 60));
      const reason = req.body?.reason ?? "manual quarantine";
      const until = setQuarantine(db, req.params.agent, minutes, reason);
      bus.emitEvent({ type: "agent.quarantined", agent: req.params.agent, until });
      return reply.code(200).send({ agent: req.params.agent, quarantinedUntil: until, reason });
    },
  );

  app.delete<{ Params: { agent: string } }>(
    "/v1/agents/:agent/quarantine",
    async (req, reply) => {
      const cleared = clearQuarantine(db, req.params.agent);
      if (!cleared) return reply.code(404).send({ error: "no active quarantine" });
      bus.emitEvent({ type: "agent.released", agent: req.params.agent });
      return reply.code(200).send({ agent: req.params.agent, quarantined: false });
    },
  );

  // ---------- policies ----------

  app.get("/v1/policies", async () => {
    const rows = db
      .prepare(`SELECT * FROM policies ORDER BY priority ASC, created_at ASC`)
      .all() as PolicyRow[];
    return rows.map(rowToPolicy);
  });

  app.get<{ Params: { id: string } }>("/v1/policies/:id", async (req, reply) => {
    const row = db
      .prepare(`SELECT * FROM policies WHERE id = ?`)
      .get(req.params.id) as PolicyRow | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    return rowToPolicy(row);
  });

  app.post<{ Body: PolicyBody }>("/v1/policies", async (req, reply) => {
    const body = req.body ?? ({} as PolicyBody);
    if (!body.name || !body.effect) {
      return reply.code(400).send({ error: "name and effect are required" });
    }
    if (!VALID_EFFECTS.includes(body.effect)) {
      return reply.code(400).send({ error: `effect must be one of ${VALID_EFFECTS.join(",")}` });
    }
    let conditionJson: string;
    try {
      conditionJson = normalizeCondition(body.condition);
    } catch {
      return reply.code(400).send({ error: "condition must be valid JSON" });
    }
    const condErr = await validateConditionShape(JSON.parse(conditionJson), db);
    if (condErr) return reply.code(400).send({ error: condErr });

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO policies
           (id, name, description, agent_pattern, action_pattern, condition, effect, priority, enabled, quarantine_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        body.name,
        body.description ?? null,
        body.agentPattern ?? "*",
        body.actionPattern ?? "*",
        conditionJson,
        body.effect,
        body.priority ?? 100,
        body.enabled === false ? 0 : 1,
        Math.max(1, Math.floor(body.quarantineMinutes ?? 60)),
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE")) return reply.code(409).send({ error: "name already exists" });
      throw err;
    }
    const row = db.prepare(`SELECT * FROM policies WHERE id = ?`).get(id) as PolicyRow;
    return reply.code(201).send(rowToPolicy(row));
  });

  app.put<{ Params: { id: string }; Body: Partial<PolicyBody> }>(
    "/v1/policies/:id",
    async (req, reply) => {
      const row = db
        .prepare(`SELECT * FROM policies WHERE id = ?`)
        .get(req.params.id) as PolicyRow | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });

      const body = req.body ?? {};
      if (body.effect && !VALID_EFFECTS.includes(body.effect)) {
        return reply.code(400).send({ error: `effect must be one of ${VALID_EFFECTS.join(",")}` });
      }
      let conditionJson = row.condition;
      if (body.condition !== undefined) {
        try {
          conditionJson = normalizeCondition(body.condition);
        } catch {
          return reply.code(400).send({ error: "condition must be valid JSON" });
        }
        const condErr = await validateConditionShape(JSON.parse(conditionJson), db);
        if (condErr) return reply.code(400).send({ error: condErr });
      }

      db.prepare(
        `UPDATE policies SET
           name = COALESCE(?, name),
           description = COALESCE(?, description),
           agent_pattern = COALESCE(?, agent_pattern),
           action_pattern = COALESCE(?, action_pattern),
           condition = ?,
           effect = COALESCE(?, effect),
           priority = COALESCE(?, priority),
           enabled = COALESCE(?, enabled),
           quarantine_minutes = COALESCE(?, quarantine_minutes),
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        body.name ?? null,
        body.description ?? null,
        body.agentPattern ?? null,
        body.actionPattern ?? null,
        conditionJson,
        body.effect ?? null,
        body.priority ?? null,
        body.enabled === undefined ? null : body.enabled ? 1 : 0,
        body.quarantineMinutes === undefined
          ? null
          : Math.max(1, Math.floor(body.quarantineMinutes)),
        req.params.id,
      );
      const updated = db
        .prepare(`SELECT * FROM policies WHERE id = ?`)
        .get(req.params.id) as PolicyRow;
      return rowToPolicy(updated);
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/policies/:id", async (req, reply) => {
    const result = db.prepare(`DELETE FROM policies WHERE id = ?`).run(req.params.id);
    if (result.changes === 0) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  app.post<{ Body: PolicyTestBody }>("/v1/policies/test", async (req, reply) => {
    const { agent, action, metadata, sessionId } = req.body ?? ({} as PolicyTestBody);
    if (!agent || !action) {
      return reply.code(400).send({ error: "agent and action are required" });
    }
    const match = await evaluatePolicies(db, {
      agent,
      action,
      metadata: metadata ?? {},
      sessionId: sessionId ?? null,
    });
    if (!match) return { match: null, decision: "pending" };
    const decision =
      match.effect === "allow" ? "approved"
      : match.effect === "deny" ? "denied"
      : match.effect === "quarantine_agent" ? "denied"
      : "pending";
    return {
      match: {
        policyId: match.policyId,
        policyName: match.policyName,
        effect: match.effect,
        quarantineMinutes: match.quarantineMinutes,
      },
      decision,
    };
  });

  // ---------- credentials ----------

  app.post<{ Body: CredentialIssueBody }>("/v1/credentials", async (req, reply) => {
    const body = req.body ?? ({} as CredentialIssueBody);
    if (!body.approvalId) {
      return reply.code(400).send({ error: "approvalId is required" });
    }
    try {
      const result = issueCredential(db, {
        approvalId: body.approvalId,
        scope: body.scope,
        ttlSeconds: body.ttlSeconds,
        maxUses: body.maxUses,
      });
      appendAudit(db, {
        approvalId: body.approvalId,
        event: "credential.issued",
        actor: "agentgate:control-plane",
        payload: {
          credentialId: result.credentialId,
          agent: result.agent,
          action: result.action,
          expiresAt: result.expiresAt,
        },
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof CredentialError) {
        const status = err.code === "approval_not_found" ? 404 : 400;
        return reply.code(status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/credentials/:id", async (req, reply) => {
    const row = getCredential(db, req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return rowToCredential(row);
  });

  app.post<{ Body: CredentialVerifyBody }>(
    "/v1/credentials/verify",
    async (req, reply) => {
      const body = req.body ?? ({} as CredentialVerifyBody);
      if (!body.token) return reply.code(400).send({ error: "token is required" });
      try {
        const result = await verifyCredential(db, {
          token: body.token,
          action: body.action,
          agent: body.agent,
          metadata: body.metadata,
        });
        return result;
      } catch (err) {
        if (err instanceof CredentialError) {
          return reply.code(403).send({
            valid: false,
            code: err.code,
            error: err.message,
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CredentialRevokeBody }>(
    "/v1/credentials/:id/revoke",
    async (req, reply) => {
      const reason = req.body?.reason ?? "manual revocation";
      const ok = revokeCredential(db, req.params.id, reason);
      if (!ok)
        return reply.code(404).send({ error: "not found or already revoked" });
      const row = getCredential(db, req.params.id);
      return rowToCredential(row!);
    },
  );

  app.get<{ Querystring: { agent?: string; approvalId?: string; limit?: string } }>(
    "/v1/credentials",
    async (req) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (req.query.agent) {
        conds.push("agent = ?");
        params.push(req.query.agent);
      }
      if (req.query.approvalId) {
        conds.push("approval_id = ?");
        params.push(req.query.approvalId);
      }
      const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT * FROM credentials ${where} ORDER BY issued_at DESC LIMIT ?`,
        )
        .all(...params) as CredentialRow[];
      return rows.map(rowToCredential);
    },
  );

  // ---------- shadow (log-only) ledger ----------
  // What the gate WOULD have blocked if it were enforcing. Lets a team see
  // their own false-positive rate before turning enforcement on. Recording here
  // never blocks anything — clients post best-effort and ignore failures.

  app.post<{
    Body: {
      agent?: string;
      action?: string;
      severity?: string;
      reason?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/v1/shadow", async (req, reply) => {
    const b = req.body ?? {};
    if (!b.agent || !b.action) {
      return reply.code(400).send({ error: "agent and action are required" });
    }
    const result = db
      .prepare(
        `INSERT INTO shadow_log (agent, action, severity, reason, source, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.agent,
        b.action,
        b.severity ?? "unknown",
        b.reason ?? null,
        b.source ?? null,
        JSON.stringify(redact(b.metadata ?? {})),
      );
    bus.emitEvent({ type: "shadow.recorded", agent: b.agent, action: b.action });
    return reply.code(201).send({ id: result.lastInsertRowid });
  });

  app.get<{ Querystring: { agent?: string; limit?: string } }>(
    "/v1/shadow",
    async (req) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (req.query.agent) {
        conds.push("agent = ?");
        params.push(req.query.agent);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const limit = Math.min(parseInt(req.query.limit ?? "200", 10) || 200, 1000);
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT * FROM shadow_log ${where} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...params) as ShadowRow[];
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM shadow_log ${where}`).get(
          ...params.slice(0, -1),
        ) as { n: number }
      ).n;
      return {
        total,
        wouldHaveBlocked: total,
        entries: rows.map((r) => ({
          id: r.id,
          agent: r.agent,
          action: r.action,
          severity: r.severity,
          reason: r.reason,
          source: r.source,
          metadata: JSON.parse(r.metadata),
          createdAt: r.created_at,
        })),
      };
    },
  );

  // ---------- events / health ----------

  app.get("/v1/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (e: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    send({ type: "hello" });
    const onEvent = (e: unknown) => send(e);
    bus.on("event", onEvent);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
    req.raw.on("close", () => {
      clearInterval(ping);
      bus.off("event", onEvent);
    });
  });

  app.get("/healthz", async () => ({ ok: true }));
}
