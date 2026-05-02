import type Database from "better-sqlite3";
import type { ApprovalRow, PolicyEffect, PolicyRow } from "./db.js";

export type PolicyMatch = {
  effect: PolicyEffect;
  policyId: string;
  policyName: string;
  quarantineMinutes?: number;
};

export type EvalContext = {
  agent: string;
  action: string;
  metadata: Record<string, unknown>;
  sessionId?: string | null;
};

export class PolicyConditionError extends Error {}

export function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp(out + "$");
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

type Cmp = (a: unknown, b: unknown) => boolean;
const cmp = (op: (x: number, y: number) => boolean): Cmp => (a, b) =>
  typeof a === "number" && typeof b === "number" && op(a, b);

const OPS: Record<string, Cmp> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  lt: cmp((x, y) => x < y),
  lte: cmp((x, y) => x <= y),
  gt: cmp((x, y) => x > y),
  gte: cmp((x, y) => x >= y),
};

type WindowSpec = {
  agent?: string; // "self" | literal | undefined (any)
  action?: string; // glob | undefined (any)
  status?: string[]; // approved | denied | pending | (defaults to all)
  windowMinutes?: number; // omitted = all-time
};

type SumSpec = WindowSpec & { field: string };

function whereClauseFromSpec(
  spec: WindowSpec,
  ctx: EvalContext,
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (spec.agent !== undefined) {
    const a = spec.agent === "self" ? ctx.agent : spec.agent;
    where.push(`agent = ?`);
    params.push(a);
  }
  if (spec.action !== undefined) {
    if (spec.action.includes("*") || spec.action.includes("?")) {
      // SQLite GLOB matches shell-style globs
      where.push(`action GLOB ?`);
      params.push(spec.action);
    } else {
      where.push(`action = ?`);
      params.push(spec.action);
    }
  }
  if (spec.status && spec.status.length > 0) {
    where.push(`status IN (${spec.status.map(() => "?").join(",")})`);
    params.push(...spec.status);
  }
  if (spec.windowMinutes !== undefined && spec.windowMinutes > 0) {
    where.push(`created_at >= datetime('now', ?)`);
    params.push(`-${spec.windowMinutes} minutes`);
  }
  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export async function evalCondition(
  expr: unknown,
  ctx: EvalContext,
  db: Database.Database,
): Promise<unknown> {
  if (expr === null || typeof expr !== "object") return expr;
  if (Array.isArray(expr)) {
    const out: unknown[] = [];
    for (const e of expr) out.push(await evalCondition(e, ctx, db));
    return out;
  }

  const obj = expr as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new PolicyConditionError(
      `condition node must have exactly one operator key, got: ${keys.join(",")}`,
    );
  }
  const [op] = keys;
  const arg = obj[op];

  switch (op) {
    case "var": {
      if (typeof arg !== "string") throw new PolicyConditionError("var requires string path");
      return getPath(ctx.metadata, arg);
    }
    case "all":
    case "any": {
      if (!Array.isArray(arg)) throw new PolicyConditionError(`${op} requires array`);
      let truthy = 0;
      for (const e of arg) {
        const v = await evalCondition(e, ctx, db);
        if (Boolean(v)) truthy++;
      }
      return op === "all" ? truthy === arg.length : truthy > 0;
    }
    case "not":
      return !(await evalCondition(arg, ctx, db));
    case "in": {
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError("in requires [needle, haystack]");
      const needle = await evalCondition(arg[0], ctx, db);
      const haystack = await evalCondition(arg[1], ctx, db);
      if (!Array.isArray(haystack)) return false;
      return haystack.includes(needle);
    }
    case "match": {
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError("match requires [value, regex]");
      const v = await evalCondition(arg[0], ctx, db);
      const re = arg[1];
      if (typeof v !== "string" || typeof re !== "string") return false;
      return new RegExp(re).test(v);
    }
    case "count": {
      if (!isPlainObject(arg)) throw new PolicyConditionError("count requires an object spec");
      const { sql, params } = whereClauseFromSpec(arg as WindowSpec, ctx);
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM approvals ${sql}`)
        .get(...params) as { n: number };
      return row.n;
    }
    case "sum": {
      if (!isPlainObject(arg)) throw new PolicyConditionError("sum requires an object spec");
      const spec = arg as SumSpec;
      if (!spec.field || typeof spec.field !== "string") {
        throw new PolicyConditionError("sum requires a field path string");
      }
      const { sql, params } = whereClauseFromSpec(spec, ctx);
      const rows = db
        .prepare(`SELECT metadata FROM approvals ${sql}`)
        .all(...params) as Array<{ metadata: string }>;
      let total = 0;
      for (const r of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.metadata);
        } catch {
          continue;
        }
        const v = getPath(parsed, spec.field);
        if (typeof v === "number" && Number.isFinite(v)) total += v;
      }
      return total;
    }
    default: {
      const cmpFn = OPS[op];
      if (!cmpFn) throw new PolicyConditionError(`unknown operator: ${op}`);
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError(`${op} requires [a, b]`);
      const a = await evalCondition(arg[0], ctx, db);
      const b = await evalCondition(arg[1], ctx, db);
      return cmpFn(a, b);
    }
  }
}

export function parseCondition(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "true") return true;
  if (trimmed === "false") return false;
  return JSON.parse(trimmed);
}

export async function evaluatePolicies(
  db: Database.Database,
  ctx: EvalContext,
): Promise<PolicyMatch | null> {
  const rows = db
    .prepare(
      `SELECT * FROM policies
       WHERE enabled = 1
       ORDER BY priority ASC, created_at ASC`,
    )
    .all() as PolicyRow[];

  for (const row of rows) {
    if (!globToRegex(row.agent_pattern).test(ctx.agent)) continue;
    if (!globToRegex(row.action_pattern).test(ctx.action)) continue;
    let condition: unknown;
    try {
      condition = parseCondition(row.condition);
    } catch {
      continue;
    }
    let result: unknown;
    try {
      result = await evalCondition(condition, ctx, db);
    } catch {
      continue;
    }
    if (Boolean(result)) {
      return {
        effect: row.effect,
        policyId: row.id,
        policyName: row.name,
        quarantineMinutes: row.quarantine_minutes ?? 60,
      };
    }
  }
  return null;
}

export type QuarantineState = {
  quarantined: boolean;
  until?: string;
  reason?: string;
};

export function getQuarantineState(
  db: Database.Database,
  agent: string,
): QuarantineState {
  const row = db
    .prepare(`SELECT * FROM agent_state WHERE agent = ?`)
    .get(agent) as
    | { quarantined_until: string | null; quarantine_reason: string | null }
    | undefined;
  if (!row || !row.quarantined_until) return { quarantined: false };
  if (new Date(row.quarantined_until).getTime() <= Date.now()) {
    return { quarantined: false };
  }
  return {
    quarantined: true,
    until: row.quarantined_until,
    reason: row.quarantine_reason ?? undefined,
  };
}

export function setQuarantine(
  db: Database.Database,
  agent: string,
  minutes: number,
  reason: string,
): string {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO agent_state (agent, quarantined_until, quarantine_reason, quarantined_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(agent) DO UPDATE SET
       quarantined_until = excluded.quarantined_until,
       quarantine_reason = excluded.quarantine_reason,
       quarantined_at = excluded.quarantined_at,
       updated_at = datetime('now')`,
  ).run(agent, until, reason);
  return until;
}

export function clearQuarantine(db: Database.Database, agent: string): boolean {
  const result = db
    .prepare(
      `UPDATE agent_state
       SET quarantined_until = NULL, quarantine_reason = NULL, updated_at = datetime('now')
       WHERE agent = ?`,
    )
    .run(agent);
  return result.changes > 0;
}

export type RecentApproval = Pick<
  ApprovalRow,
  "id" | "action" | "status" | "created_at" | "decided_by"
>;
