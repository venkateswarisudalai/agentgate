/**
 * diagnose() — the "AI" step of the incident agent.
 *
 * With ANTHROPIC_API_KEY set, it reasons over the log buffer + deploy history
 * with Claude and returns a structured diagnosis. Without a key (or if the call
 * fails), it falls back to a deterministic heuristic so the demo always runs.
 *
 * Claude usage notes (from the claude-api skill):
 *   - model claude-opus-4-8
 *   - structured output via output_config.format (json_schema) — no prefill
 *   - adaptive thinking + medium effort
 *   - the SRE runbook is a cached system block (stable prefix); the volatile
 *     logs/deploy facts go in the user turn, after the cache breakpoint
 */
import Anthropic from "@anthropic-ai/sdk";

export type IncidentInput = {
  service: string;
  currentVersion: string;
  errorRate: number; // 0..1
  baselineRate: number; // 0..1
  deployVersion: string | null;
  secondsSinceDeploy: number | null;
  recentLogs: string[];
};

export type Diagnosis = {
  rootCause: string;
  remediation: string;
  rollbackPlan: string;
  confidence: "high" | "medium" | "low";
  source: "claude" | "heuristic";
};

// Stable across runs → good cache prefix. In a real product this is a much
// larger runbook library; Opus caches prefixes ≥ 4096 tokens.
const RUNBOOK = `You are a careful, defensive senior site reliability engineer triaging a
production incident. You are given a service's recent logs and its deploy history.

Operating principles:
- Correlate the error spike with recent deploys before blaming anything else. A
  spike that begins within ~2 minutes of a deploy is almost certainly that deploy.
- Prefer the smallest, most reversible remediation. A rollback of a bad deploy beats
  re-architecting. Restarting one pod beats scaling the fleet.
- ALWAYS include a concrete rollback plan for your proposed remediation — the exact
  command or steps to undo it if the remediation makes things worse.
- Be honest about confidence. If the spike does not correlate with a deploy, say so
  and set confidence to "low".

Return ONLY the structured diagnosis. Be specific and operational, not generic.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rootCause: { type: "string", description: "The most likely root cause, specific to these logs/deploys." },
    remediation: { type: "string", description: "The single best remediation to apply now." },
    rollbackPlan: { type: "string", description: "Exact steps/command to undo the remediation if it worsens things." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["rootCause", "remediation", "rollbackPlan", "confidence"],
} as const;

function buildUserText(i: IncidentInput): string {
  const deploy =
    i.deployVersion && i.secondsSinceDeploy !== null
      ? `Most recent deploy: ${i.service} → ${i.deployVersion}, ${i.secondsSinceDeploy}s ago.`
      : `No recent deploy on record.`;
  return [
    `Service: ${i.service} (currently running ${i.currentVersion})`,
    `Current 5xx error rate: ${(i.errorRate * 100).toFixed(1)}% (baseline ~${(i.baselineRate * 100).toFixed(1)}%)`,
    deploy,
    ``,
    `Recent logs (most recent last):`,
    ...i.recentLogs.slice(-40),
    ``,
    `Diagnose the incident and propose a remediation with a rollback plan.`,
  ].join("\n");
}

async function diagnoseWithClaude(i: IncidentInput): Promise<Diagnosis> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const resp = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: RUNBOOK, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserText(i) }],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "medium" },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as Omit<Diagnosis, "source">;
  return { ...parsed, source: "claude" };
}

function diagnoseHeuristic(i: IncidentInput): Diagnosis {
  const deployCorrelated = i.secondsSinceDeploy !== null && i.secondsSinceDeploy < 120;
  return {
    rootCause: deployCorrelated
      ? `Error spike began ~${i.secondsSinceDeploy}s after deploy ${i.currentVersion} — almost certainly a bad deploy.`
      : `Error spike with no correlated recent deploy — needs deeper investigation.`,
    remediation: `Roll back ${i.service} ${i.currentVersion} → ${i.deployVersion ? "previous version" : "last known good"}.`,
    rollbackPlan: `Re-deploy the prior image: kubectl rollout undo deploy/${i.service}. Verify 5xx returns to baseline.`,
    confidence: deployCorrelated ? "high" : "low",
    source: "heuristic",
  };
}

export async function diagnose(i: IncidentInput): Promise<Diagnosis> {
  if (!process.env.ANTHROPIC_API_KEY) return diagnoseHeuristic(i);
  try {
    return await diagnoseWithClaude(i);
  } catch (err) {
    process.stderr.write(`  (Claude diagnosis failed — ${(err as Error).message}; using heuristic)\n`);
    return diagnoseHeuristic(i);
  }
}
