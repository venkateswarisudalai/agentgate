import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentGate } from "@agentgate/sdk";
import type { IncidentContext } from "./pagerduty.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEVOPS_AGENT_DIR = resolve(__dirname, "../../");
const REPO_ROOT = resolve(__dirname, "../../../../");
const HOOK_PATH = resolve(REPO_ROOT, "packages/claude-code-hook/dist/index.js");

const gate = new AgentGate({
  baseUrl: process.env.AGENTGATE_URL ?? "http://localhost:4000",
  agent: "devops-agent-autonomous",
});

const SHIPIT_CLUSTER = process.env.SHIPIT_CLUSTER ?? "unboundsecurity-cluster-nclpwi";
const SHIPIT_REGION = process.env.SHIPIT_REGION ?? "us-west-2";
const MAX_BUDGET_USD = process.env.MAX_BUDGET_USD ?? "2.00";

/**
 * Run the DevOps agent against a single incident.
 *
 * Strategy: shell out to `claude -p` with:
 *   - the SRE persona as the system prompt
 *   - incident details + the incident-response runbook as the user prompt
 *   - a settings JSON wiring the agentgate hook on PreToolUse
 *   - bypassPermissions mode so the *hook* is the only gate (not Claude Code's permission UI)
 *   - a hard model-spend cap
 *
 * The hook recognizes destructive shipit/kubectl/helm/terraform/etc. commands
 * and routes them through agentgate for human approval.
 */
export async function handleIncident(incident: IncidentContext): Promise<void> {
  const session = await gate.beginSession({
    incidentId: incident.incidentId,
    service: incident.service,
    app: incident.app,
    severity: incident.severity,
    alertType: incident.alertType,
    triggeredAt: incident.triggeredAt,
    summary: incident.summary,
  });

  console.log(`[incident ${incident.incidentId}] session=${session.id} started`);

  try {
    const systemPrompt = readFileSync(resolve(DEVOPS_AGENT_DIR, "system-prompt.md"), "utf-8");
    const runbook = readFileSync(resolve(DEVOPS_AGENT_DIR, "runbooks/incident-response.md"), "utf-8");

    const userPrompt = buildUserPrompt(incident, runbook);
    const settingsJson = buildSettingsJson();
    const claudeBin = process.env.CLAUDE_BIN ?? "claude";

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        claudeBin,
        [
          "-p", userPrompt,
          "--system-prompt", systemPrompt,
          "--settings", settingsJson,
          "--permission-mode", "bypassPermissions",
          "--max-budget-usd", MAX_BUDGET_USD,
          "--output-format", "text",
        ],
        {
          env: {
            ...process.env,
            AGENTGATE_SESSION_ID: session.id,
            AGENTGATE_AGENT: "devops-agent-autonomous",
            AGENTGATE_INCIDENT_ID: incident.incidentId,
          },
          stdio: "inherit",
          cwd: DEVOPS_AGENT_DIR,
        },
      );

      child.on("error", rejectPromise);
      child.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`claude exited with code ${code}`));
      });
    });

    console.log(`[incident ${incident.incidentId}] agent finished`);
  } catch (err) {
    console.error(`[incident ${incident.incidentId}] agent error:`, err);
  } finally {
    await gate.endSession(session.id);
    console.log(`[incident ${incident.incidentId}] session=${session.id} ended`);
  }
}

function buildSettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: `node ${HOOK_PATH}` }],
        },
      ],
    },
  });
}

function buildUserPrompt(incident: IncidentContext, runbook: string): string {
  return [
    `# Production incident — autonomous triage`,
    ``,
    `A PagerDuty alert just fired. You are running unattended; there is no human in the chat to ask`,
    `clarifying questions. Investigate read-only, then propose ONE remediation. The agentgate hook`,
    `is active on every Bash/Edit call — destructive commands will pause for human approval before`,
    `they run. That is your safety net; use it freely.`,
    ``,
    `## Incident`,
    ``,
    `- PagerDuty incident: ${incident.incidentId}`,
    `- Service: ${incident.service}`,
    `- Shipit app: \`${incident.app}\``,
    `- Alert type: ${incident.alertType}`,
    `- Severity: ${incident.severity}`,
    `- Triggered at: ${incident.triggeredAt}`,
    `- Summary: ${incident.summary}`,
    ``,
    `## Environment`,
    ``,
    `You have shell access via Bash. The following CLIs are configured on PATH:`,
    `- \`shipit\` — Unbound's PaaS CLI. Use \`shipit apps revisions <app>\`, \`shipit logs <app>\`, \`shipit apps rollback <app> --revision N\`.`,
    `- \`kubectl\` — pointed at cluster \`${SHIPIT_CLUSTER}\` in region \`${SHIPIT_REGION}\`, namespace \`shipit\`. Use \`kubectl get pods -l app=<app>\`, \`kubectl logs <pod>\`, \`kubectl describe <kind>/<name>\`.`,
    `- \`aws\` — for CloudWatch logs/metrics if you need cross-cutting context.`,
    ``,
    `Each Shipit app maps to one Kubernetes Deployment + Service in namespace \`shipit\`.`,
    `Shipit auto-tracks up to 10 revisions per app and supports \`shipit apps rollback\` for fast revert.`,
    ``,
    `## Runbook (incident-response.md)`,
    ``,
    runbook,
    ``,
    `## What to do now`,
    ``,
    `1. Investigate read-only first: \`kubectl get pods\`, \`kubectl logs\`, \`shipit apps revisions ${incident.app}\`. Form a diagnosis.`,
    `2. If you have a confident remediation (most often: \`shipit apps rollback ${incident.app} --revision <N>\` or \`kubectl rollout restart deployment/${incident.app}\`), propose ONE and run it. The hook will pause for approval.`,
    `3. If you don't have a confident remediation, write a clear handoff note and stop. Do not guess in production.`,
    ``,
    `Begin.`,
  ].join("\n");
}
