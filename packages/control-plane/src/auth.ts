// Bearer-token authentication + role authorization for the control plane.
//
// The control plane makes one promise: "a human approved THIS exact action."
// That promise is only worth anything if the approver's identity cannot be
// forged. Before this module, `POST /v1/approvals/:id/decide` took `decidedBy`
// as free-text and the server bound to 0.0.0.0 with no token check — anyone who
// could reach the port could stamp any identity onto any approval.
//
// Two operating modes:
//
//   • TEAM MODE (one or more tokens configured) — every /v1 request must carry
//     a valid `Authorization: Bearer <token>`. The approver's identity is taken
//     from the token's principal, never from the request body. Required to bind
//     a non-loopback interface.
//
//   • DEV MODE (no tokens configured) — for the zero-config local first run.
//     The server refuses to bind anything but loopback, so "reaching the port"
//     means you are already on the machine. Requests are stamped with a single
//     non-forgeable local identity (`local:<os-user>`); the body's `decidedBy`
//     is still ignored, so you can no longer impersonate `alice@company.com`.
//
// This is a developer-adopted safety net with an audited, identity-bound
// approval step — not an unbypassable security boundary. See README.

import { timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";

export type Role = "agent" | "operator" | "admin";

export type Principal = {
  id: string;
  role: Role;
};

export type AuthConfig = {
  /** token string -> principal */
  tokens: Map<string, Principal>;
  /** true when at least one token is configured (TEAM MODE) */
  configured: boolean;
  /** identity stamped on requests in DEV MODE */
  devActor: string;
};

const ROLES: readonly Role[] = ["agent", "operator", "admin"];

function devActorName(): string {
  try {
    return `local:${userInfo().username}`;
  } catch {
    return "local:unknown";
  }
}

/**
 * Build auth config from environment.
 *
 *   AGENTGATE_TOKEN          operator token (humans who approve/deny)
 *   AGENTGATE_AGENT_TOKEN    agent token (SDK/hook/gate that create approvals)
 *   AGENTGATE_ADMIN_TOKEN    admin token (full access)
 *   AGENTGATE_TOKENS         JSON array of { id, role, token } for multi-user
 *
 * Any combination may be set. If none are set, the server runs in DEV MODE.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const tokens = new Map<string, Principal>();

  const add = (token: string | undefined, principal: Principal) => {
    const t = (token ?? "").trim();
    if (t) tokens.set(t, principal);
  };

  add(env.AGENTGATE_TOKEN, { id: env.AGENTGATE_OPERATOR_ID ?? "operator", role: "operator" });
  add(env.AGENTGATE_AGENT_TOKEN, { id: env.AGENTGATE_AGENT_ID ?? "agent", role: "agent" });
  add(env.AGENTGATE_ADMIN_TOKEN, { id: env.AGENTGATE_ADMIN_ID ?? "admin", role: "admin" });

  if (env.AGENTGATE_TOKENS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.AGENTGATE_TOKENS);
    } catch {
      throw new Error("AGENTGATE_TOKENS must be valid JSON (array of {id, role, token})");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("AGENTGATE_TOKENS must be a JSON array");
    }
    for (const e of parsed as Array<Record<string, unknown>>) {
      const id = String(e.id ?? "").trim();
      const role = String(e.role ?? "").trim() as Role;
      const token = String(e.token ?? "").trim();
      if (!id || !token || !ROLES.includes(role)) {
        throw new Error(
          `invalid AGENTGATE_TOKENS entry: each needs id, token, role in {${ROLES.join(",")}}`,
        );
      }
      tokens.set(token, { id, role });
    }
  }

  return { tokens, configured: tokens.size > 0, devActor: devActorName() };
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve a request's Authorization header to a principal, or null.
 * Token comparison is timing-safe to avoid leaking valid tokens byte-by-byte.
 */
export function authenticate(
  config: AuthConfig,
  authHeader: string | undefined,
): Principal | null {
  const token = extractBearer(authHeader);
  if (!token) return null;
  const tokenBuf = Buffer.from(token);
  for (const [known, principal] of config.tokens) {
    const knownBuf = Buffer.from(known);
    if (knownBuf.length === tokenBuf.length && timingSafeEqual(knownBuf, tokenBuf)) {
      return principal;
    }
  }
  return null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

export function canApprove(principal: Principal): boolean {
  return principal.role === "operator" || principal.role === "admin";
}
