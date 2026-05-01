import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ApprovalRow, AuditRow } from "./db.js";
import { bus } from "./events.js";

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
    const metaJson = JSON.stringify(metadata ?? {});
    db.prepare(
      `INSERT INTO approvals (id, agent, action, reason, metadata, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(id, agent, action, reason, metaJson);
    db.prepare(
      `INSERT INTO audit_log (approval_id, event, actor, payload)
       VALUES (?, 'approval.created', ?, ?)`,
    ).run(id, agent, metaJson);
    bus.emitEvent({ type: "approval.created", approvalId: id });
    return reply.code(201).send({ id });
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
