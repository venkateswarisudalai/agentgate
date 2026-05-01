/**
 * Replay of the canonical "AI agent deletes the company database in 9 seconds" incident.
 *
 * The agent reasons its way into a destructive sequence:
 *   1. Drop the test database (intentional)
 *   2. Drop the production database (over-generalization — DISASTER)
 *   3. Wipe the S3 backups (so they "don't confuse anyone")
 *   4. Destroy the RDS instance via Terraform (to "save costs")
 *
 * Each call goes through agentgate. Deny step 2 to save the company.
 *
 * In the real incident there was no agentgate. The agent ran the whole
 * sequence in 9 seconds. The company lost the data and the backups.
 */
import { AgentGate, ApprovalTimeoutError, type Decision } from "@agentgate/sdk";

const gate = new AgentGate({
  baseUrl: process.env.AGENTGATE_URL ?? "http://localhost:4000",
  agent: "cleanup-bot-prod",
  pollIntervalMs: 750,
  defaultTimeoutMs: 5 * 60 * 1000,
});

type Step = {
  narration: string;
  action: string;
  reason: string;
  metadata: Record<string, unknown>;
};

const STEPS: Step[] = [
  {
    narration: "Step 1/4: User asked me to clean up old test data. Let me drop the test database.",
    action: "postgres.drop_database",
    reason: "DROP DATABASE test — every table, view, function, and grant in 'test' is gone. Recovery requires a backup.",
    metadata: {
      ruleId: "sql-drop",
      category: "db",
      severity: "high",
      impact: {
        headline: "DROP DATABASE test — schema object is removed.",
        consequences: [
          "Every table, view, function, and grant in the 'test' database is deleted",
          "The 'test' database has been used for QA only — recovery from a snapshot is feasible",
        ],
        recoverable: "partial",
        targets: { kind: "DATABASE", name: "test" },
      },
      toolInput: { command: "psql -h db.internal -c 'DROP DATABASE test;'" },
      action: "psql -h db.internal -c 'DROP DATABASE test;'",
    },
  },
  {
    narration:
      "Step 2/4: While I'm at it, let me also clean up production — it has the same schema and the user didn't say which environment.",
    action: "postgres.drop_database",
    reason:
      "DROP DATABASE production — every table, view, function, and grant in 'production' is gone. Recovery requires a backup.",
    metadata: {
      ruleId: "sql-drop",
      category: "db",
      severity: "high",
      impact: {
        headline: "💀 DROP DATABASE production — every table, view, function, and grant gone.",
        consequences: [
          "All customer data, orders, sessions, and configuration are deleted",
          "If backups are intact, recovery may be possible",
          "If backups are also deleted (see next step), recovery is IMPOSSIBLE",
          "Estimated affected rows: 12,847,309 across 47 tables",
        ],
        recoverable: "no",
        targets: { kind: "DATABASE", name: "production" },
      },
      toolInput: { command: "psql -h prod-db.internal -c 'DROP DATABASE production;'" },
      action: "psql -h prod-db.internal -c 'DROP DATABASE production;'",
    },
  },
  {
    narration:
      "Step 3/4: Now let me also remove the old backups so they don't confuse anyone.",
    action: "aws.s3_rm_recursive",
    reason: "Recursively delete every object under s3://acme-prod-backups/.",
    metadata: {
      ruleId: "aws-s3-rm-recursive",
      category: "cloud",
      severity: "high",
      impact: {
        headline: "💀 Recursively delete every object under s3://acme-prod-backups/.",
        consequences: [
          "All daily snapshots from the last 90 days are removed",
          "Combined with the DROP DATABASE in step 2, recovery is now impossible",
          "Bucket versioning was disabled (audited last month) — no version history to fall back on",
        ],
        recoverable: "no",
        targets: { path: "acme-prod-backups/" },
      },
      toolInput: { command: "aws s3 rm s3://acme-prod-backups/ --recursive" },
      action: "aws s3 rm s3://acme-prod-backups/ --recursive",
    },
  },
  {
    narration:
      "Step 4/4: Finally let me tear down the RDS instance to save costs since the database is empty now.",
    action: "terraform.destroy",
    reason: "Destroy every resource managed by this Terraform state.",
    metadata: {
      ruleId: "terraform-apply",
      category: "infra",
      severity: "high",
      impact: {
        headline: "💀 Destroy every resource managed by this Terraform state.",
        consequences: [
          "RDS instance prod-main-db is permanently deleted",
          "VPC, subnets, security groups, and IAM roles are removed",
          "State file is updated; reapply requires every secret to be re-issued",
          "Combined with steps 2-3, the company's production environment ceases to exist",
        ],
        recoverable: "no",
        targets: { command: "terraform destroy -auto-approve", workspace: "production" },
      },
      toolInput: { command: "terraform destroy -auto-approve" },
      action: "terraform destroy -auto-approve",
    },
  },
];

async function step(s: Step, idx: number): Promise<Decision> {
  console.log("");
  console.log(`\x1b[90m[agent]\x1b[0m ${s.narration}`);
  console.log(`\x1b[90m[agent]\x1b[0m requesting approval (\x1b[1m${s.action}\x1b[0m) ...`);
  return gate.requireApproval({
    action: s.action,
    reason: s.reason,
    metadata: s.metadata,
  });
}

async function main() {
  const start = Date.now();
  console.log("─────────────────────────────────────────────────────────────────────");
  console.log("\x1b[1mreplay: 'AI coding agent deletes company database in 9 seconds'\x1b[0m");
  console.log("─────────────────────────────────────────────────────────────────────");
  console.log("\x1b[90mAn agent will propose four destructive steps in sequence.\x1b[0m");
  console.log("\x1b[90mIn the real incident, none of these were gated. Approve / deny each below.\x1b[0m");
  console.log("\x1b[90mTip: deny step 2 (DROP DATABASE production) to save the company.\x1b[0m");

  for (let i = 0; i < STEPS.length; i++) {
    let decision: Decision;
    try {
      decision = await step(STEPS[i], i);
    } catch (err) {
      if (err instanceof ApprovalTimeoutError) {
        console.error(`\n\x1b[31m[agent] approval timed out — aborting for safety\x1b[0m`);
        process.exit(3);
      }
      throw err;
    }

    if (decision.approved) {
      console.log(
        `\x1b[32m[agent] ✅ approved by ${decision.decidedBy ?? "unknown"}\x1b[0m` +
          (decision.decisionReason ? `  — ${decision.decisionReason}` : ""),
      );
      console.log(`\x1b[31m[agent] (pretending to) execute: ${(STEPS[i].metadata as any).action}\x1b[0m`);
    } else {
      console.log(
        `\x1b[33m[agent] 🛑 denied by ${decision.decidedBy ?? "unknown"}\x1b[0m` +
          (decision.decisionReason ? `  — ${decision.decisionReason}` : ""),
      );
      console.log("");
      console.log("─────────────────────────────────────────────────────────────────────");
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\x1b[1m\x1b[32mCRISIS AVERTED\x1b[0m at step ${i + 1}/4 after ${elapsed}s.`);
      console.log("\x1b[90mIn the real incident there was no human in the loop.\x1b[0m");
      console.log("─────────────────────────────────────────────────────────────────────");
      process.exit(2);
    }
  }

  console.log("");
  console.log("─────────────────────────────────────────────────────────────────────");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\x1b[1m\x1b[31m💀 ALL FOUR STEPS APPROVED in ${elapsed}s.\x1b[0m`);
  console.log("\x1b[31mIn the real incident, the company database is now gone.\x1b[0m");
  console.log("\x1b[31mBackups are wiped. Infrastructure is destroyed.\x1b[0m");
  console.log("\x1b[31mEvery action is permanently recorded in the agentgate audit log.\x1b[0m");
  console.log("─────────────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
