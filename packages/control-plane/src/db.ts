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
  session_id: string | null;
};

export type AuditRow = {
  id: number;
  approval_id: string;
  event: string;
  actor: string | null;
  payload: string;
  created_at: string;
};

export type PolicyEffect = "allow" | "deny" | "require_approval" | "quarantine_agent";

export type PolicyRow = {
  id: string;
  name: string;
  description: string | null;
  agent_pattern: string;
  action_pattern: string;
  condition: string;
  effect: PolicyEffect;
  priority: number;
  enabled: number;
  quarantine_minutes: number | null;
  created_at: string;
  updated_at: string;
};

export type SessionStatus = "active" | "ended";

export type SessionRow = {
  id: string;
  agent: string;
  status: SessionStatus;
  metadata: string;
  started_at: string;
  ended_at: string | null;
};

export type AgentStateRow = {
  agent: string;
  quarantined_until: string | null;
  quarantine_reason: string | null;
  quarantined_at: string | null;
  updated_at: string;
};

export type CredentialRow = {
  id: string;
  approval_id: string;
  agent: string;
  action: string;
  scope: string;
  max_uses: number;
  use_count: number;
  expires_at: string;
  issued_at: string;
  revoked: number;
  revoked_at: string | null;
  revoked_reason: string | null;
};

export type SecretRow = {
  key: string;
  value: string;
  created_at: string;
};

type ColumnInfo = { name: string };

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as ColumnInfo[];
  return rows.some((r) => r.name === column);
}

function migrate(db: Database.Database): void {
  if (!hasColumn(db, "approvals", "session_id")) {
    db.exec(`ALTER TABLE approvals ADD COLUMN session_id TEXT`);
  }
  if (!hasColumn(db, "policies", "quarantine_minutes")) {
    db.exec(`ALTER TABLE policies ADD COLUMN quarantine_minutes INTEGER DEFAULT 60`);
  }
  // Widen policies.effect CHECK constraint to include 'quarantine_agent'.
  const tbl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='policies'`)
    .get() as { sql: string } | undefined;
  if (tbl && !tbl.sql.includes("'quarantine_agent'")) {
    db.exec(`
      PRAGMA foreign_keys=off;
      BEGIN TRANSACTION;
      ALTER TABLE policies RENAME TO policies_old;
      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        agent_pattern TEXT NOT NULL DEFAULT '*',
        action_pattern TEXT NOT NULL DEFAULT '*',
        condition TEXT NOT NULL DEFAULT 'true',
        effect TEXT NOT NULL CHECK (effect IN ('allow','deny','require_approval','quarantine_agent')),
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        quarantine_minutes INTEGER DEFAULT 60,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO policies (id, name, description, agent_pattern, action_pattern, condition, effect, priority, enabled, quarantine_minutes, created_at, updated_at)
      SELECT id, name, description, agent_pattern, action_pattern, condition, effect, priority, enabled,
             COALESCE(quarantine_minutes, 60),
             created_at, updated_at
      FROM policies_old;
      DROP TABLE policies_old;
      CREATE INDEX IF NOT EXISTS idx_policies_eval ON policies(enabled, priority ASC, created_at ASC);
      COMMIT;
      PRAGMA foreign_keys=on;
    `);
  }
}

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent_action_time
      ON approvals(agent, action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      agent_pattern TEXT NOT NULL DEFAULT '*',
      action_pattern TEXT NOT NULL DEFAULT '*',
      condition TEXT NOT NULL DEFAULT 'true',
      effect TEXT NOT NULL CHECK (effect IN ('allow','deny','require_approval','quarantine_agent')),
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      quarantine_minutes INTEGER DEFAULT 60,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_policies_eval
      ON policies(enabled, priority ASC, created_at ASC);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
      metadata TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, started_at DESC);

    CREATE TABLE IF NOT EXISTS agent_state (
      agent TEXT PRIMARY KEY,
      quarantined_until TEXT,
      quarantine_reason TEXT,
      quarantined_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '{}',
      max_uses INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      revoked_reason TEXT,
      FOREIGN KEY (approval_id) REFERENCES approvals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_agent_time
      ON credentials(agent, issued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_credentials_approval
      ON credentials(approval_id);

    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrate(db);
  return db;
}
