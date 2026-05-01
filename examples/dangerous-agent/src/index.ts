import { AgentGate, ApprovalTimeoutError } from "@agentgate/sdk";

const gate = new AgentGate({
  baseUrl: process.env.AGENTGATE_URL ?? "http://localhost:4000",
  agent: "support-bot-prod",
  pollIntervalMs: 750,
  defaultTimeoutMs: 5 * 60 * 1000,
});

async function dropProdTable(): Promise<void> {
  console.log("\n  💀 (pretending to) DROP TABLE customers;\n");
}

async function main() {
  console.log("[agent] starting up");
  console.log("[agent] reasoning... I should clean up old customers by dropping the table");
  console.log("[agent] requesting approval from agentgate before destructive action\n");

  try {
    const decision = await gate.requireApproval({
      action: "postgres.drop_table",
      reason: "Cleaning up old data — about to drop customers table",
      metadata: {
        database: "prod-main",
        table: "customers",
        estimatedRows: 1_204_532,
        sql: "DROP TABLE customers;",
      },
    });

    if (decision.approved) {
      console.log(`[agent] ✅ approved by ${decision.decidedBy} at ${decision.decidedAt}`);
      await dropProdTable();
      console.log("[agent] done.");
    } else {
      console.log(`[agent] 🛑 denied by ${decision.decidedBy} at ${decision.decidedAt}`);
      console.log(`[agent] reason: ${decision.decisionReason ?? "(none provided)"}`);
      console.log("[agent] aborting destructive action. crisis averted.");
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof ApprovalTimeoutError) {
      console.error("[agent] ⏱  approval timed out — aborting for safety");
      process.exit(3);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
