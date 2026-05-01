// Heuristic risk classifier for MCP tool calls.
// MCP tools have a name (string) and arguments (JSON object). We don't know
// what each tool does — but tool names follow strong conventions (verbs).

export type Risk = "high" | "medium" | "low";

export type Decision = {
  risk: Risk;
  reasons: string[];
  headline: string;
  consequences: string[];
  recoverable: "no" | "partial" | "yes" | "unknown";
};

const HIGH_VERBS = [
  "delete", "drop", "destroy", "remove", "revoke", "terminate",
  "purge", "wipe", "clear", "reset", "uninstall", "kill",
  "publish", "deploy", "promote", "rollback", "force",
];
const MEDIUM_VERBS = [
  "create", "write", "post", "put", "update", "patch", "modify",
  "set", "send", "execute", "run", "trigger", "invoke",
];
const SAFE_VERBS = [
  "read", "list", "get", "describe", "show", "search", "query",
  "find", "fetch", "view", "inspect", "lookup", "count",
];

const DANGER_ARG_KEYS = new Set([
  "force", "permanent", "cascade", "recursive", "skip_confirmation",
  "skip_checks", "no_dry_run", "production", "prod", "delete_data",
  "purge", "yes", "all",
]);

const PRIVILEGED_ARG_KEYS = new Set([
  "admin", "root", "is_admin", "elevated", "sudo", "as_root",
]);

function lcWords(name: string): string[] {
  // splits "deleteUser", "delete_user", "DELETE-user", "Stripe.refund" → ["delete","user"]
  return name
    .split(/[._\-/]/)
    .flatMap((p) => p.split(/(?=[A-Z])/))
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function valueLooksDangerous(v: unknown): string | null {
  if (typeof v === "boolean" && v === true) return "boolean true";
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (/(^|[\W_])(prod|production)([\W_]|$)/.test(s)) return `references prod ('${v.slice(0, 60)}')`;
    if (/^https?:\/\/.*\.(com|io|net|ai|app)\//.test(v) && /(prod|api|admin)/.test(s)) return `prod-like URL ('${v.slice(0, 60)}')`;
    if (/^\/(?:etc|var|usr|sys|root|home)\//.test(v)) return `system path ('${v.slice(0, 60)}')`;
  }
  if (typeof v === "number" && v >= 1000) return `large number (${v})`;
  return null;
}

export function classify(toolName: string, args: Record<string, unknown>): Decision {
  const words = lcWords(toolName);
  const reasons: string[] = [];
  let risk: Risk = "low";

  if (words.some((w) => HIGH_VERBS.includes(w))) {
    risk = "high";
    reasons.push(`verb in tool name suggests destruction (${words.filter((w) => HIGH_VERBS.includes(w)).join(", ")})`);
  } else if (words.some((w) => MEDIUM_VERBS.includes(w))) {
    risk = "medium";
    reasons.push(`verb in tool name suggests mutation (${words.filter((w) => MEDIUM_VERBS.includes(w)).join(", ")})`);
  } else if (!words.some((w) => SAFE_VERBS.includes(w))) {
    // Unknown verb — be cautious.
    risk = "medium";
    reasons.push("unknown verb in tool name (no read/list/get/etc.) — treating as mutation");
  }

  for (const [k, v] of Object.entries(args || {})) {
    if (DANGER_ARG_KEYS.has(k.toLowerCase()) && (v === true || v === "true" || v === 1)) {
      reasons.push(`dangerous arg: ${k}=${JSON.stringify(v)}`);
      risk = "high";
    }
    if (PRIVILEGED_ARG_KEYS.has(k.toLowerCase()) && v) {
      reasons.push(`privileged arg: ${k}=${JSON.stringify(v)}`);
      if (risk !== "high") risk = "high";
    }
    const dv = valueLooksDangerous(v);
    if (dv) {
      reasons.push(`arg ${k}: ${dv}`);
      if (risk === "low") risk = "medium";
    }
  }

  const headline = `MCP tool '${toolName}' — ${risk.toUpperCase()} risk classification.`;
  const consequences =
    risk === "high"
      ? [
          "Tool name and/or args suggest a destructive or irreversible operation",
          "Effect depends on the underlying MCP server, but the verb pattern is strong",
        ]
      : risk === "medium"
        ? [
            "Tool appears to mutate state (write/update/etc.) — usually recoverable, sometimes not",
          ]
        : [
            "Tool appears read-only based on naming convention",
          ];

  return {
    risk,
    reasons,
    headline,
    consequences,
    recoverable: risk === "high" ? "no" : risk === "medium" ? "partial" : "yes",
  };
}
