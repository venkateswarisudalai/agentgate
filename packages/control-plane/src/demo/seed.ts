// Demo policy seeding. Idempotent: only inserts policies that aren't already
// present (matched by name). Demo policies are namespaced with the `demo:`
// prefix and target only `demo:*` agents so they never affect real traffic.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

type DemoPolicy = {
  name: string;
  description: string;
  agentPattern: string;
  actionPattern: string;
  condition: string; // JSON string
  effect: "allow" | "deny" | "require_approval" | "quarantine_agent";
  priority: number;
  quarantineMinutes?: number;
};

const DEMO_POLICIES: DemoPolicy[] = [
  {
    name: "demo:typosquat-block",
    description:
      "Auto-deny any install where pkg-scan flags the package as a typosquat.",
    agentPattern: "demo:install-agent",
    actionPattern: "package.install",
    condition: JSON.stringify({
      eq: [{ var: "pkg_scan.verdict" }, "high"],
    }),
    effect: "deny",
    priority: 10,
  },
  {
    name: "demo:drop-table-quarantine",
    description:
      "Auto-deny + quarantine any agent that tries to DROP a table.",
    agentPattern: "demo:data-agent",
    actionPattern: "postgres.execute",
    condition: JSON.stringify({
      eq: [{ var: "ruleId" }, "demo:postgres-drop"],
    }),
    effect: "quarantine_agent",
    priority: 10,
    quarantineMinutes: 60,
  },
  {
    name: "demo:refund-over-limit",
    description: "Refunds over $1,000 require a human.",
    agentPattern: "demo:refund-bot",
    actionPattern: "stripe.refund.create",
    condition: JSON.stringify({
      gt: [{ var: "amount_cents" }, 100_000],
    }),
    effect: "require_approval",
    priority: 20,
  },
];

export function seedDemoPolicies(db: Database.Database): {
  inserted: number;
  skipped: number;
} {
  let inserted = 0;
  let skipped = 0;
  const select = db.prepare(`SELECT id FROM policies WHERE name = ?`);
  const insert = db.prepare(
    `INSERT INTO policies
       (id, name, description, agent_pattern, action_pattern, condition, effect, priority, enabled, quarantine_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  for (const p of DEMO_POLICIES) {
    const exists = select.get(p.name) as { id: string } | undefined;
    if (exists) {
      skipped++;
      continue;
    }
    insert.run(
      randomUUID(),
      p.name,
      p.description,
      p.agentPattern,
      p.actionPattern,
      p.condition,
      p.effect,
      p.priority,
      p.quarantineMinutes ?? 60,
    );
    inserted++;
  }
  return { inserted, skipped };
}

// Wipe demo state so the visitor (or the next visitor) can start fresh.
// Touches only rows whose agent starts with "demo:" — never affects real data.
export function resetDemoState(db: Database.Database): {
  approvals: number;
  audit: number;
  sessions: number;
  agentState: number;
} {
  const tx = db.transaction(() => {
    const approvals = db
      .prepare(`DELETE FROM approvals WHERE agent LIKE 'demo:%'`)
      .run().changes;
    // audit_log rows are linked to approvals; clean orphans by approval_id NOT IN approvals.
    const audit = db
      .prepare(
        `DELETE FROM audit_log
         WHERE approval_id IS NOT NULL
           AND approval_id NOT IN (SELECT id FROM approvals)`,
      )
      .run().changes;
    const sessions = db
      .prepare(`DELETE FROM sessions WHERE agent LIKE 'demo:%'`)
      .run().changes;
    const agentState = db
      .prepare(`DELETE FROM agent_state WHERE agent LIKE 'demo:%'`)
      .run().changes;
    return { approvals, audit, sessions, agentState };
  });
  return tx();
}

// Visible for testing
export const __DEMO_POLICIES = DEMO_POLICIES;
export type { DemoPolicy };
