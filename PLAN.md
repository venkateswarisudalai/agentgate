# agentgate — Build Plan

## The wedge

**Production safety for AI agents.** Engineering buyer (platform team / SRE / founding eng), not compliance buyer. Pain is acute today: every team putting agents in prod has had a near-miss or real incident. Existing IAM/RBAC tooling assumes a stable, deterministic actor — agents are neither.

We sell the control plane that sits between agents and dangerous tools, with three primitives:

1. **Human-in-the-loop approvals** — risky actions pause until approved.
2. **Policy engine** — declarative rules that auto-approve or auto-deny without a human (e.g. `refund < $100 → allow; refund > $5000 → deny`).
3. **Just-in-time scoped credentials** — agents never hold long-lived prod creds; they request a 5-minute, scoped token per action.

Audit log is a byproduct of all three and is what wins the compliance conversation later, top-down. We do not lead with compliance.

## v0 scope (week 1, today)

Just primitive #1 — HITL approval — done well, with audit log.

| Component | Stack | Status |
|---|---|---|
| SDK | TypeScript, fetch-based, polls control plane | v0 |
| Control plane | Node 22, Fastify, better-sqlite3, SSE | v0 |
| Dashboard | Static HTML + vanilla JS, served by control plane | v0 |
| Example | A fake "agent" that tries to drop a prod table | v0 |

Deliberately *not* in v0: auth, multi-tenancy, policy engine, scoped creds, Python SDK, Slack, hosted version. All scheduled below.

## 8-week roadmap

| Week | Theme | Deliverable |
|---|---|---|
| 1 | **HITL** | v0 — SDK + control plane + dashboard + example. Audit log. (today) |
| 2 | **Policy** | Declarative rule engine. YAML or JSON; `allow_if`, `deny_if`, `require_approval_if`. Evaluated server-side. |
| 3 | **Python SDK** | Same SDK shape for Python. LangGraph + Cursor users. |
| 4 | **Slack** | Approval requests posted to Slack with rich diffs. Approve/deny via button. |
| 5 | **Auth + multi-tenant** | Clerk for orgs/users/projects. API keys per project. |
| 6 | **OSS launch** | Apache 2.0, docs site, Docker compose, HN + AI Engineer Discord launch. |
| 7 | **Hosted cloud** | Stripe billing, free tier (10k decisions/mo), one-click migrate self-host → cloud. |
| 8 | **Design partners** | Land 5 from launch traffic. Free for now in exchange for weekly 30-min calls. |

## Distribution

OSS-led, like every winner in adjacent categories (HashiCorp Vault, Langfuse, Helicone, Phoenix). Engineers will not adopt a closed-source proxy in front of their prod systems. Self-host first; cloud version is a managed convenience.

## Strategic notes

- **Founder-market fit:** the buyer is an SRE / platform engineer, the same persona we already are. We can have these conversations tomorrow without learning a new vocabulary.
- **Top of funnel:** developer tool, free OSS, distributed via dev community channels (HN, Discord, X/twitter dev community).
- **Defensibility:** agent identity model + policy DSL + ergonomic SDK across vendors/frameworks. Adjacent players (Permit.io, OPA, Lasso, Vault) each solve one slice; nobody owns the agent-aware action layer.
- **Compliance is downstream**, not upstream. Audit log unlocks SOC2/HIPAA/EU AI Act conversations once we have a customer base, not before.

## Origin story

Founder personally observed a recent production data deletion incident (April 2026). Specifics to be added to founder narrative once shareable.
