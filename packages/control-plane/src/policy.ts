import type Database from "better-sqlite3";
import type { PolicyEffect, PolicyRow } from "./db.js";

export type PolicyMatch = {
  effect: PolicyEffect;
  policyId: string;
  policyName: string;
};

export type EvalContext = {
  agent: string;
  action: string;
  metadata: Record<string, unknown>;
};

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

export class PolicyConditionError extends Error {}

export function evalCondition(expr: unknown, ctx: EvalContext): unknown {
  if (expr === null || typeof expr !== "object") return expr;
  if (Array.isArray(expr)) return expr.map((e) => evalCondition(e, ctx));

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
      const results = arg.map((e) => Boolean(evalCondition(e, ctx)));
      return op === "all" ? results.every(Boolean) : results.some(Boolean);
    }
    case "not":
      return !evalCondition(arg, ctx);
    case "in": {
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError("in requires [needle, haystack]");
      const needle = evalCondition(arg[0], ctx);
      const haystack = evalCondition(arg[1], ctx);
      if (!Array.isArray(haystack)) return false;
      return haystack.includes(needle);
    }
    case "match": {
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError("match requires [value, regex]");
      const v = evalCondition(arg[0], ctx);
      const re = arg[1];
      if (typeof v !== "string" || typeof re !== "string") return false;
      return new RegExp(re).test(v);
    }
    default: {
      const cmpFn = OPS[op];
      if (!cmpFn) throw new PolicyConditionError(`unknown operator: ${op}`);
      if (!Array.isArray(arg) || arg.length !== 2)
        throw new PolicyConditionError(`${op} requires [a, b]`);
      const a = evalCondition(arg[0], ctx);
      const b = evalCondition(arg[1], ctx);
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

export function evaluatePolicies(
  db: Database.Database,
  ctx: EvalContext,
): PolicyMatch | null {
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
      result = evalCondition(condition, ctx);
    } catch {
      continue;
    }
    if (Boolean(result)) {
      return { effect: row.effect, policyId: row.id, policyName: row.name };
    }
  }
  return null;
}
