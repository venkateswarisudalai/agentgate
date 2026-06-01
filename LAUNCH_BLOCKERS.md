# Launch blockers — fix before public Product Hunt / HN launch

Decision (2026-05-30): launch agent-led + open source, but **fix the top
security blockers first.** Two independent evaluators (CISO buyer-lens + VP-Eng
daily-user lens) read the actual `packages/` code and converged on the same
issues. PH crowd will `git clone` and find these in an hour — fix, then launch.

The repo-only PH submission is ready in `PRODUCT_HUNT_REPO.md` — do NOT post it
until P0 + P1 below are done.

---

## ✅ STATUS (2026-05-31): P0 + P1 all RESOLVED on branch `harden/control-plane-p0`

All five launch blockers are fixed, with unit + route + runtime coverage
(196 tests passing across the workspace). Where each landed:

- **P0-1 Auth/authz** — `packages/control-plane/src/auth.ts` (new), wired in
  `index.ts` (loopback default, refuse non-loopback without auth) and
  `routes.ts` (onRequest auth hook; decide actor bound to authenticated
  principal; requester ≠ approver enforced). Dashboard sends a stored bearer.
- **P0-2 Tamper-evident audit + redaction** — `packages/control-plane/src/audit.ts`
  (new): hash-chained `appendAudit`, recursive `redact`, `verifyAuditChain` +
  `GET /v1/audit/verify`. Signing secret now prefers `AGENTGATE_SIGNING_SECRET`.
- **P0-3 Fail-open killed** — `packages/claude-code-hook/src/index.ts`: the
  `AGENTGATE_FAIL_OPEN` env bypass is gone; outages fail **closed**.
- **P1-4 Over-gating** — default gate floor is now **high/irreversible only**
  (`gating.ts` in hook + mcp-gate); medium/routine is opt-in
  (`AGENTGATE_MIN_SEVERITY=medium` / `--gate-medium`). Classifiers untouched.
- **P1-5 Shadow mode** — `AGENTGATE_SHADOW=1` / `--shadow` + shadow ledger
  (`shadow_log` table, `POST/GET /v1/shadow`).

README now states the enforcement boundary honestly ("Security model & trust
boundary"). **Remaining before posting `PRODUCT_HUNT_REPO.md`:** merge this
branch to `main`, then launch.

---

## P0 — must fix (both evaluators flagged; these are "unsafe", not "early")

### 1. Authentication + authorization on the control plane
The core promise — "a human approved this exact action" — is currently forgeable.
- `packages/control-plane/src/routes.ts`: `POST /v1/approvals/:id/decide` takes
  `decidedBy` as **free-text** in the body (`actor = decidedBy ?? "anonymous"`).
  Anyone who can reach :4000 can approve and stamp any identity.
- `packages/control-plane/src/index.ts`: server binds `0.0.0.0` by default; no
  API-key/token validation (SDK sends a bearer, server never checks it).
- **Fix:** require an auth token on all mutating routes; authenticated `decidedBy`
  (no free-text actor); enforce requester ≠ approver server-side; refuse to bind
  non-loopback unless auth is configured; TLS by default for non-loopback.

### 2. Tamper-evident audit log + secret/PII redaction
- `packages/control-plane/src/db.ts`: `audit_log` is a plain SQLite table, no
  hash chaining / append-only guarantee — any local process can edit rows.
- Full `toolInput` / MCP `arguments` are stored verbatim (secrets, connection
  strings, PII) and served unredacted via `GET /v1/audit`.
- `packages/control-plane/src/credentials.ts`: signing secret stored plaintext in
  the same SQLite (`getOrCreateSigningSecret`).
- **Fix:** hash-chain (or sign) each audit entry; redact known-secret fields
  before write; move/encrypt the signing secret out of the audited store.

### 3. Kill the client-side fail-open bypass
- `packages/claude-code-hook/src/index.ts`: `AGENTGATE_FAIL_OPEN=1` lets the hook
  **allow** actions when the control plane is unreachable — a one-env-var bypass
  that neutralizes the control while the dashboard still shows green.
- **Fix:** make fail-open a **server-side, audited, role-gated policy**, not a
  client env var. Default fail-closed (already is — keep it).

## P1 — must fix for adoption (eng-leader: "default UX is approve-everything")

### 4. Stop over-gating by default
- `packages/mcp-gate/src/heuristics.ts`: any non-read verb (`create`, `send`,
  `update`, `run`, …) auto-bumped to `medium` and gated → benign actions
  (`save_issue`, `send_message`, `update-page`) all pause. → approval fatigue.
- `packages/claude-code-hook/src/rules.ts`: any path matching
  `prod`/`production`/`secret`/`credentials`/`.env` freezes — a monorepo with
  `services/production/` freezes on every `Write`.
- **Fix:** default to **high-severity / irreversible-only** gating; make
  routine-write gating opt-in; tune the verb classifier.

### 5. Ship a shadow (log-only) mode
- No per-team mode that logs what it *would* have blocked without freezing.
- **Fix:** add `--shadow` / log-only; the #1 adoption primitive — let a team see
  their own false-positive rate for two weeks before enforcement bites.

---

## P2 — strengthens the pitch, not launch-blocking
- Wire JIT scoped credentials into the actual enforcement path (SDK has
  `issueCredential`/`verifyCredential`; gate/hook don't use them yet — so the
  "agents never hold long-lived creds" claim isn't true in the shipping path).
- Policy auto-approve for "rollback to last-known-good during a firing alert" so
  the gate adds zero MTTR on the one case you want the agent to just act.
- Slack approval (on-call lives in Slack, not a localhost tab) — already week-4 on roadmap.
- HA path off single-process SQLite (Postgres) before anything sits synchronously in prod path.
- One real SIEM forwarder (CEF/OTEL/syslog → Splunk/Sentinel) for audit value.

---

## Definition of launch-ready
P0 (1–3) done + P1 (4–5) done + README/quickstart honestly reflects the
enforcement boundary (it's a developer-adopted safety net + audited approval,
not an unbypassable security boundary — say so). Then post `PRODUCT_HUNT_REPO.md`.
