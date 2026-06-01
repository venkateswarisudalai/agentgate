// Tamper-evident, redacted audit log.
//
// Two guarantees the plain `INSERT INTO audit_log` calls did not provide:
//
//  1. Tamper-evidence — each row stores a SHA-256 hash chained over the
//     previous row's hash. Editing or deleting any historical row breaks the
//     chain from that point forward, which `verifyAuditChain` detects. This is
//     evidence, not prevention: a local process can still rewrite rows, but it
//     can no longer do so *silently*.
//
//  2. Redaction — secrets / PII in tool inputs (passwords, tokens, connection
//     strings, private keys, AWS keys) are scrubbed BEFORE they are written, so
//     the forensic log is not itself a secret store and `GET /v1/audit` cannot
//     leak credentials.
//
// All audit writes funnel through `appendAudit` so both guarantees hold for
// every event, no matter which route produced it.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

const REDACTED = "«redacted»";

// Keys whose VALUE is almost always a secret/credential — redacted wholesale
// regardless of value type. Deliberately broad: over-redacting an audit log is
// safe, under-redacting is a leak.
const SECRET_KEY_RE =
  /(pass(word|wd)?|secret|token|api[_-]?key|access[_-]?key|priv(ate)?[_-]?key|client[_-]?secret|credential|authorization|aws[_-]?secret|connection[_-]?string|conn[_-]?str|\bdsn\b|sas[_-]?token|cookie|bearer)/i;

// Value shapes that are secrets even when the key name is innocent (e.g. a
// command string with an embedded key). Matched substrings are scrubbed in
// place so surrounding context (the command, the host) survives.
const VALUE_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
];

function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  // Redact the password in URI userinfo: scheme://user:pass@host → scheme://user:«redacted»@host
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s:@/]+)@/gi,
    `$1:${REDACTED}@`,
  );
  return out;
}

/**
 * Recursively redact secrets/PII from an arbitrary JSON-ish value. Pure — never
 * mutates its input. Object keys matching a known secret name are replaced
 * wholesale; string values are scrubbed for embedded secret patterns.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function chainHash(
  prevHash: string,
  approvalId: string,
  event: string,
  actor: string | null,
  payloadJson: string,
  createdAt: string,
): string {
  return sha256hex(
    [prevHash, approvalId, event, actor ?? "", payloadJson, createdAt].join("\n"),
  );
}

export type AuditEntry = {
  approvalId: string;
  event: string;
  actor: string | null;
  payload: unknown;
};

/**
 * The single audit write path. Redacts the payload, chains it onto the previous
 * row's hash, and inserts. Synchronous (better-sqlite3) so the read-last-then-
 * insert is atomic within a process.
 */
export function appendAudit(db: Database.Database, entry: AuditEntry): void {
  const prev = db
    .prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`)
    .get() as { hash: string | null } | undefined;
  const prevHash = prev?.hash ?? "";
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(redact(entry.payload ?? {}));
  const hash = chainHash(
    prevHash,
    entry.approvalId,
    entry.event,
    entry.actor,
    payloadJson,
    createdAt,
  );
  db.prepare(
    `INSERT INTO audit_log (approval_id, event, actor, payload, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.approvalId, entry.event, entry.actor, payloadJson, createdAt, prevHash, hash);
}

export type AuditVerifyResult = {
  ok: boolean;
  length: number;
  /** id of the first row whose stored hash does not match its recomputed hash */
  brokenAt: number | null;
};

/**
 * Walk the whole chain and recompute every hash. A mismatch means a row was
 * edited, deleted, or reordered after it was written.
 */
export function verifyAuditChain(db: Database.Database): AuditVerifyResult {
  const rows = db
    .prepare(
      `SELECT id, approval_id, event, actor, payload, created_at, prev_hash, hash
       FROM audit_log ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    approval_id: string;
    event: string;
    actor: string | null;
    payload: string;
    created_at: string;
    prev_hash: string | null;
    hash: string | null;
  }>;

  let prevHash = "";
  for (const r of rows) {
    // The stored prev_hash must equal the running hash, and the row hash must
    // recompute. Either mismatch is tampering.
    if ((r.prev_hash ?? "") !== prevHash) {
      return { ok: false, length: rows.length, brokenAt: r.id };
    }
    const expected = chainHash(
      prevHash,
      r.approval_id,
      r.event,
      r.actor,
      r.payload,
      r.created_at,
    );
    if (expected !== r.hash) {
      return { ok: false, length: rows.length, brokenAt: r.id };
    }
    prevHash = r.hash!;
  }
  return { ok: true, length: rows.length, brokenAt: null };
}
