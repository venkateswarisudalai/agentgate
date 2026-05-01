import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ApprovalRow, AuditRow, PolicyEffect, PolicyRow } from "./db.js";
import { bus } from "./events.js";
import {
  evaluatePolicies,
  evalCondition,
  parseCondition,
  PolicyConditionError,
} from "./policy.js";

type CreateBody = {
  agent: string;
  action: string;
  reason: string;
  metadata?: Record<string, unknown>;
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
};

type PolicyTestBody = {
  agent: string;
  action: string;
  metadata?: Record<string, unknown>;
};

const VALID_EFFECTS: readonly PolicyEffect[] = ["allow", "deny", "require_approval"];

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
    createdAt: row.created_at,
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

function validateConditionShape(condition: unknown): string | null {
  try {
    evalCondition(condition, { agent: "_probe", action: "_probe", metadata: {} });
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
    metadata: JSON.parse(row.metadata),
    status: row.status,
    approved: row.status === "approved",
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
  };
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post<{ Body: CreateBody }>("/v1/approvals", async (req, reply) => {
    const { agent, action, reason, metadata } = req.body ?? ({} as CreateBody);
    if (!agent || !action || !reason) {
      return reply.code(400).send({ error: "agent, action, and reason are required" });
    }
    const id = randomUUID();
    const meta = metadata ?? {};
    const metaJson = JSON.stringify(meta);

    const match = evaluatePolicies(db, { agent, action, metadata: meta });
    const autoDecide =
      match && (match.effect === "allow" || match.effect === "deny") ? match : null;

    if (autoDecide) {
      const status = autoDecide.effect === "allow" ? "approved" : "denied";
      const actor = `policy:${autoDecide.policyName}`;
      db.prepare(
        `INSERT INTO approvals
           (id, agent, action, reason, metadata, status, decided_by, decided_at, decision_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      ).run(
        id,
        agent,
        action,
        reason,
        metaJson,
        status,
        actor,
        `auto-${status} by policy ${autoDecide.policyName}`,
      );
      db.prepare(
        `INSERT INTO audit_log (approval_id, event, actor, payload)
         VALUES (?, 'approval.created', ?, ?)`,
      ).run(id, agent, metaJson);
      db.prepare(
        `INSERT INTO audit_log (approval_id, event, actor, payload)
         VALUES (?, ?, ?, ?)`,
      ).run(
        id,
        `approval.auto_${status}`,
        actor,
        JSON.stringify({ policyId: autoDecide.policyId, policyName: autoDecide.policyName }),
      );
      bus.emitEvent({ type: "approval.created", approvalId: id });
      bus.emitEvent({ type: "approval.decided", approvalId: id, status });
      return reply
        .code(201)
        .send({ id, status, decidedBy: actor, policy: autoDecide.policyName });
    }

    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, metadata, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(id, agent, action, reason, metaJson);
    db.prepare(
      `INSERT INTO audit_log (approval_id, event, actor, payload)
       VALUES (?, 'approval.created', ?, ?)`,
    ).run(id, agent, metaJson);
    if (match && match.effect === "require_approval") {
      db.prepare(
        `INSERT INTO audit_log (approval_id, event, actor, payload)
         VALUES (?, 'approval.policy_matched', ?, ?)`,
      ).run(
        id,
        `policy:${match.policyName}`,
        JSON.stringify({ policyId: match.policyId, policyName: match.policyName }),
      );
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

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    "/v1/approvals",
    async (req) => {
      const status = req.query.status;
      const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
      const rows = (
        status
          ? db
              .prepare(
                `SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
              )
              .all(status, limit)
          : db
              .prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`)
              .all(limit)
      ) as ApprovalRow[];
      return rows.map(rowToDecision);
    },
  );

  app.post<{ Params: { id: string }; Body: DecideBody }>(
    "/v1/approvals/:id/decide",
    async (req, reply) => {
      const { id } = req.params;
      const { approved, decidedBy, reason } = req.body ?? ({} as DecideBody);
      if (typeof approved !== "boolean") {
        return reply.code(400).send({ error: "approved (boolean) is required" });
      }
      const row = db
        .prepare(`SELECT * FROM approvals WHERE id = ?`)
        .get(id) as ApprovalRow | undefined;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.status !== "pending") {
        return reply.code(409).send({ error: `already ${row.status}` });
      }
      const status = approved ? "approved" : "denied";
      const actor = decidedBy ?? "anonymous";
      db.prepare(
        `UPDATE approvals
         SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
         WHERE id = ?`,
      ).run(status, actor, reason ?? null, id);
      db.prepare(
        `INSERT INTO audit_log (approval_id, event, actor, payload)
         VALUES (?, ?, ?, ?)`,
      ).run(id, `approval.${status}`, actor, JSON.stringify({ reason }));
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
    const condErr = validateConditionShape(JSON.parse(conditionJson));
    if (condErr) return reply.code(400).send({ error: condErr });

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO policies
           (id, name, description, agent_pattern, action_pattern, condition, effect, priority, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const condErr = validateConditionShape(JSON.parse(conditionJson));
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
    const { agent, action, metadata } = req.body ?? ({} as PolicyTestBody);
    if (!agent || !action) {
      return reply.code(400).send({ error: "agent and action are required" });
    }
    const match = evaluatePolicies(db, { agent, action, metadata: metadata ?? {} });
    if (!match) return { match: null, decision: "pending" };
    return {
      match: { policyId: match.policyId, policyName: match.policyName, effect: match.effect },
      decision:
        match.effect === "allow" ? "approved"
        : match.effect === "deny" ? "denied"
        : "pending",
    };
  });

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
