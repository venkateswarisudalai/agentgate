import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRow = {
  id: string;
  agent: string;
  action: string;
  reason: string;
  metadata: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
};

export type AuditRow = {
  id: number;
  approval_id: string;
  event: string;
  actor: string | null;
  payload: string;
  created_at: string;
};

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
      decided_by TEXT,
      decided_at TEXT,
      decision_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (approval_id) REFERENCES approvals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_approval ON audit_log(approval_id, id);
  `);
  return db;
}
