// Gating policy knobs for the MCP gate — pure, unit-testable.
//
//   • minRisk (default "high") — only destructive/irreversible tool calls pause
//     by default. Benign mutations (`save_issue`, `send_message`, `update_page`,
//     classified "medium") forward without a prompt. This is the fix for the
//     "default UX is approve-everything" complaint. Opt into stricter gating
//     with --gate-medium / AGENTGATE_MIN_SEVERITY=medium.
//
//   • shadow — log what WOULD have been gated and forward it, so a team can
//     measure their false-positive rate before enforcing.

export type Risk = "low" | "medium" | "high" | "critical";

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: string): number {
  return RANK[s.toLowerCase()] ?? RANK.medium;
}

export function shouldGate(risk: string, minRisk: string): boolean {
  return severityRank(risk) >= severityRank(minRisk);
}

export function parseMinRisk(value: string | undefined, env: NodeJS.ProcessEnv): Risk {
  const v = (value ?? env.AGENTGATE_MIN_SEVERITY ?? "high").toLowerCase();
  return (["low", "medium", "high", "critical"].includes(v) ? v : "high") as Risk;
}

export function isShadowMode(flag: boolean, env: NodeJS.ProcessEnv): boolean {
  return flag || env.AGENTGATE_SHADOW === "1" || env.AGENTGATE_SHADOW === "true";
}

/** Best-effort shadow record. Never throws — must not affect tool execution. */
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
