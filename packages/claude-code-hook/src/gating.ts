// Gating policy knobs — kept pure and separate from the I/O-heavy hook so they
// can be unit-tested.
//
// Two adoption levers the evaluators asked for:
//
//   • MIN_SEVERITY (default "high") — only irreversible/destructive actions
//     pause by default. Routine writes (medium) are opt-in. This is what stops
//     the "approve-everything" first-run experience: a monorepo with a
//     `services/production/` dir no longer freezes on every Write.
//
//   • SHADOW — log what WOULD have been gated and allow it. Lets a team measure
//     their own false-positive rate before enforcement bites.

export type Severity = "low" | "medium" | "high" | "critical";

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: string): number {
  return RANK[s.toLowerCase()] ?? RANK.medium;
}

/** A match gates only if its severity meets or exceeds the configured floor. */
export function shouldGate(severity: string, minSeverity: string): boolean {
  return severityRank(severity) >= severityRank(minSeverity);
}

export function parseMinSeverity(env: NodeJS.ProcessEnv): Severity {
  const v = (env.AGENTGATE_MIN_SEVERITY ?? "high").toLowerCase();
  return (["low", "medium", "high", "critical"].includes(v) ? v : "high") as Severity;
}

export function isShadowMode(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTGATE_SHADOW === "1" || env.AGENTGATE_SHADOW === "true";
}

/**
 * Best-effort shadow record to the control plane. Never throws — shadow logging
 * must not affect the agent's execution. Returns true if recorded.
 */
export async function recordShadow(
  baseUrl: string,
  apiKey: string | undefined,
  body: {
    agent: string;
    action: string;
    severity: string;
    reason?: string;
    source: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/shadow`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}
