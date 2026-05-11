// Demo scenarios — synthetic agents that exercise the full agentgate loop.
// Each runs in-process inside the control plane and calls the SDK against the
// local server, so visitors can experience a complete approval flow without
// installing anything. Metadata is shaped to render richly in the dashboard
// (impact.headline + impact.consequences are first-class in public/index.html).

import { AgentGate } from "@agentgate/sdk";

export type ScenarioId =
  | "refund-bot"
  | "coding-agent"
  | "deploy-agent"
  | "data-agent"
  | "install-agent";

export type ScenarioDef = {
  id: ScenarioId;
  agent: string;
  title: string;
  pitch: string;          // shown on the demo card
  outcomeHint: string;    // tells the visitor what to expect
  expectedEffect: "human" | "auto-allow" | "auto-deny" | "quarantine";
  emoji: string;
};

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "refund-bot",
    agent: "demo:refund-bot",
    title: "Support agent issues a $5,000 refund",
    pitch:
      "A support bot decided a customer deserves a $5,000 refund. Policy says anything over $1,000 needs a human.",
    outcomeHint: "Pauses for human approval",
    expectedEffect: "human",
    emoji: "💳",
  },
  {
    id: "coding-agent",
    agent: "demo:coding-agent",
    title: "Coding agent runs `rm -rf /var/log/*`",
    pitch:
      "An agent is 'cleaning up disk space' on a production host. Irreversible. No backups.",
    outcomeHint: "Pauses for human approval",
    expectedEffect: "human",
    emoji: "💻",
  },
  {
    id: "deploy-agent",
    agent: "demo:deploy-agent",
    title: "Deploy agent applies Terraform to prod",
    pitch:
      "An ops agent wants to `terraform apply` a 47-resource diff to the production AWS account during business hours.",
    outcomeHint: "Pauses for human approval",
    expectedEffect: "human",
    emoji: "🚀",
  },
  {
    id: "data-agent",
    agent: "demo:data-agent",
    title: "Data agent runs `DROP TABLE users`",
    pitch:
      "A data agent reasoned its way to dropping the users table. Policy auto-denies and quarantines the agent.",
    outcomeHint: "Auto-denied + quarantined by policy",
    expectedEffect: "quarantine",
    emoji: "💀",
  },
  {
    id: "install-agent",
    agent: "demo:install-agent",
    title: "Install agent runs `npm install reqcuests`",
    pitch:
      "Looks like a typo of `requests`. Classic typosquat. Policy auto-denies before any code lands on disk.",
    outcomeHint: "Auto-denied by policy",
    expectedEffect: "auto-deny",
    emoji: "📦",
  },
];

type RunOptions = {
  baseUrl: string;
  onLog?: (line: string) => void;
};

type RunResult = {
  approvalId: string | null;
  status: "approved" | "denied" | "pending" | "timed_out" | "error";
  message: string;
};

function gateFor(agent: string, baseUrl: string): AgentGate {
  return new AgentGate({
    baseUrl,
    agent,
    pollIntervalMs: 500,
    defaultTimeoutMs: 2 * 60 * 1000, // 2 min for demo
  });
}

async function runRefund(opts: RunOptions): Promise<RunResult> {
  const gate = gateFor("demo:refund-bot", opts.baseUrl);
  const decision = await gate.requireApproval({
    action: "stripe.refund.create",
    reason:
      "Customer requested refund: 'order #38291 arrived damaged, very upset'",
    metadata: {
      severity: "high",
      category: "payment",
      ruleId: "demo:refund-over-limit",
      amount_cents: 500_000,
      currency: "USD",
      customer_id: "cus_NfQzC1jH9vPq",
      order_id: "order_38291",
      stripe_account: "acct_LIVE_prod",
      impact: {
        headline: "$5,000.00 USD will be refunded to a live customer card.",
        recoverable: "no",
        consequences: [
          "Stripe issues a refund within seconds — cannot be undone via API.",
          "Customer is notified by Stripe email immediately.",
          "Charges back against this month's revenue.",
          "If automated incorrectly across many customers, easily a 5-figure incident.",
        ],
      },
    },
  });
  return decisionToResult(decision);
}

async function runCoding(opts: RunOptions): Promise<RunResult> {
  const gate = gateFor("demo:coding-agent", opts.baseUrl);
  const decision = await gate.requireApproval({
    action: "shell.exec",
    reason:
      "Cleaning up disk space — host /var partition is at 92% capacity and the agent identified /var/log as the largest consumer.",
    metadata: {
      severity: "high",
      category: "filesystem",
      ruleId: "shell.rm-recursive",
      host: "prod-api-7",
      cwd: "/",
      toolInput: {
        command: "rm -rf /var/log/*",
      },
      impact: {
        headline: "Permanent deletion of all logs on prod-api-7.",
        recoverable: "no",
        consequences: [
          "Loss of last 14 days of application + nginx + auth logs.",
          "Active log writers will start failing (SIGPIPE) until restart.",
          "Compliance: 90-day retention requirement breached for SOC 2.",
          "Incident response will be blind for any issue rooted before now.",
        ],
      },
    },
  });
  return decisionToResult(decision);
}

async function runDeploy(opts: RunOptions): Promise<RunResult> {
  const gate = gateFor("demo:deploy-agent", opts.baseUrl);
  const decision = await gate.requireApproval({
    action: "terraform.apply",
    reason:
      "Apply pending infrastructure changes from the open PR. Plan was generated 14 min ago and has not been re-validated.",
    metadata: {
      severity: "high",
      category: "cloud",
      ruleId: "terraform.apply.production",
      account: "aws-prod-987654321",
      region: "us-west-2",
      workspace: "prod",
      plan_summary: "+12 ~ 9 -26 (47 resources)",
      destroyed: [
        "aws_db_instance.primary",
        "aws_elasticache_cluster.cache",
        "aws_lb.public",
        "aws_security_group.web",
      ],
      toolInput: {
        command: "terraform apply -auto-approve tfplan.binary",
      },
      impact: {
        headline:
          "Destroys 26 resources in production, including the primary RDS database.",
        recoverable: "partial",
        consequences: [
          "RDS primary will be terminated — 4–8 min restore from automated backup.",
          "Public load balancer DNS changes — propagation up to 60s.",
          "All current sessions / WebSockets dropped.",
          "Plan is stale (14 min old); state may have drifted.",
        ],
      },
    },
  });
  return decisionToResult(decision);
}

async function runData(opts: RunOptions): Promise<RunResult> {
  const gate = gateFor("demo:data-agent", opts.baseUrl);
  const decision = await gate.requireApproval({
    action: "postgres.execute",
    reason:
      "Removing the users table to reset onboarding metrics for the new quarter — agent reasoned this was equivalent to TRUNCATE.",
    metadata: {
      severity: "high",
      category: "database",
      ruleId: "demo:postgres-drop",
      database: "prod-main",
      table: "users",
      estimated_rows: 4_812_399,
      toolInput: {
        command: "DROP TABLE users;",
      },
      impact: {
        headline:
          "Drops the live users table (4.8M rows). Cascades to 11 dependent tables.",
        recoverable: "no",
        consequences: [
          "Total customer login outage — every session invalidated.",
          "Cascading deletes across auth, billing, sessions, audit_log.",
          "Restore from last nightly snapshot loses up to 23 hours of writes.",
          "Pages every on-call within 60 seconds.",
        ],
      },
    },
  });
  return decisionToResult(decision);
}

async function runInstall(opts: RunOptions): Promise<RunResult> {
  const gate = gateFor("demo:install-agent", opts.baseUrl);
  const decision = await gate.requireApproval({
    action: "package.install",
    reason:
      "Adding HTTP client for the new ingest service — agent picked the first npm result that matched 'request library'.",
    metadata: {
      severity: "high",
      category: "supply-chain",
      ruleId: "pkg-scan:typosquat",
      package_manager: "npm",
      package: "reqcuests",
      version: "0.1.7",
      toolInput: {
        command: "npm install reqcuests",
      },
      pkg_scan: {
        verdict: "high",
        signals: [
          "typosquat: edit distance 1 from 'requests'",
          "publisher: 4 days old, no other packages",
          "no repository field",
          "postinstall script present (suspicious)",
        ],
      },
      impact: {
        headline:
          "Likely typosquat of `requests`. Postinstall script could exfiltrate credentials.",
        recoverable: "partial",
        consequences: [
          "Postinstall scripts run with full developer/CI privileges.",
          "Common payload: read ~/.aws, ~/.npmrc, env vars; POST to attacker.",
          "Rotation of every leaked credential, audit of every CI run since.",
          "If shipped to prod, a supply-chain incident on the customer side.",
        ],
      },
    },
  });
  return decisionToResult(decision);
}

const RUNNERS: Record<ScenarioId, (opts: RunOptions) => Promise<RunResult>> = {
  "refund-bot": runRefund,
  "coding-agent": runCoding,
  "deploy-agent": runDeploy,
  "data-agent": runData,
  "install-agent": runInstall,
};

export async function runScenario(
  id: ScenarioId,
  opts: RunOptions,
): Promise<RunResult> {
  const fn = RUNNERS[id];
  if (!fn) return { approvalId: null, status: "error", message: `unknown scenario ${id}` };
  try {
    return await fn(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { approvalId: null, status: "error", message: msg };
  }
}

function decisionToResult(decision: {
  id: string;
  approved: boolean;
  decidedBy: string | null;
}): RunResult {
  return {
    approvalId: decision.id,
    status: decision.approved ? "approved" : "denied",
    message: decision.approved
      ? `approved by ${decision.decidedBy ?? "unknown"}`
      : `denied by ${decision.decidedBy ?? "unknown"}`,
  };
}
