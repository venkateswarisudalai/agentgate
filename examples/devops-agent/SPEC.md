# DevOps Agent — Specification

**Status:** v1 design
**Owner:** Venka
**Depends on:** `@agentgate/sdk`, `@agentgate/control-plane`, `@agentgate/claude-code-hook`, `@agentgate/mcp-gate`

## Goal

A defensive AI SRE that triages production incidents and proposes fixes, with every dangerous action gated through agentgate.

Two operating modes:

1. **Interactive (existing).** A human asks Claude Code "investigate why X is failing." The persona, runbooks, and hook are already in place — see `README.md` and `system-prompt.md`.
2. **Autonomous incident triage (new in v1).** A PagerDuty alert fires → an agent loop runs unattended → it investigates read-only → proposes a remediation → calls `gate.requireApproval()` → on approval, executes; on denial, posts the diagnosis back to the incident.

This spec covers mode 2 and how it composes with the existing assets.

## Why this shape

- **Reuse, don't replace.** The system prompt, runbooks, rule pack, and MCP bundle already encode the safe-SRE behavior. The autonomous loop loads the same artifacts so behavior is consistent across modes.
- **agentgate is the safety boundary, not the agent.** The agent stays a thin Claude loop. All "is this safe to do" logic lives in the control plane (rule pack + policy engine + human approval).
- **Narrow before broad.** v1 handles one alert family (pod CrashLoop / high error rate) on one platform (Shipit/EKS). Everything else escalates to a human.

## Non-goals (v1)

- Auto-remediation without a human (every write goes through `requireApproval`, no exceptions).
- Multi-cloud — Shipit/EKS only.
- Stateful learning across incidents (no fine-tuning, no memory persistence beyond audit log).
- Replacing PagerDuty's existing escalation policies.
- Customer-data investigations (escalate per `system-prompt.md` §"explicitly NOT competent at").

## Existing assets (reused as-is)

| Asset | Role in v1 |
|---|---|
| `system-prompt.md` | Loaded as the agent's system prompt verbatim |
| `runbooks/incident-response.md` | Pulled into context when an alert fires |
| `runbooks/rollback.md`, `scale-out.md` | Pulled in based on proposed remediation type |
| `rule-pack.json` | Drives policy decisions in the control plane (when v0.2 ships rule-file loading) |
| `mcp-bundle/` | Provides the read tools (filesystem, k8s, postgres, github, aws) wrapped through `mcp-gate` |
| `claude-code-hook` | Catches dangerous shell calls in *interactive* mode; not used in autonomous mode (see §Tool gating) |

## New components (v1)

### 1. PagerDuty receiver
A small Fastify route or standalone Node service.

- **Endpoint:** `POST /webhooks/pagerduty`
- **Auth:** PD's webhook signature (HMAC) verified before processing
- **Action:** Normalizes the PD payload into an `IncidentContext` and triggers a new agent run
- **v1 simplification:** ship a `--fixture <file.json>` mode that replays a saved payload, so the loop is testable without a real PD account

```ts
type IncidentContext = {
  incidentId: string;          // PD incident id, used for idempotency
  service: string;             // mapped from PD service → Shipit app name
  severity: "P1" | "P2" | "P3";
  alertType: "crashloop" | "error-rate" | "latency" | "unknown";
  triggeredAt: string;         // ISO
  rawAlert: unknown;           // full PD payload for context
};
```

Mapping PD service → Shipit app comes from a static config file in v1 (`pagerduty-mapping.json`).

### 2. Agent runner
A Node process that wraps the Claude API in a tool-use loop.

- **SDK:** `@anthropic-ai/sdk` (TypeScript)
- **Model:** `claude-opus-4-7` for planning; can fall back to Sonnet for follow-ups (cost/latency tuning post-v1)
- **System prompt:** the contents of `system-prompt.md` plus an autonomous-mode addendum (no human in the chat to ask clarifying questions; degrade by escalating, not by guessing)
- **Tool definitions:** see §Tools below
- **Termination:** loop ends when the agent emits a `finish_diagnosis` tool call OR a destructive action is proposed and the approval resolves
- **Budget:** hard cap of 30 tool calls / 10 minutes / $X model spend per incident; on hit, write current state to PD timeline and stop

### 3. Tool definitions

Tools are split into three buckets by side-effect:

#### Read-only (no gating)
| Tool | Wraps | Notes |
|---|---|---|
| `kubectl_get_pods` | `kubectl get pods -n <ns> -l app=<app>` | Returns parsed JSON |
| `kubectl_describe` | `kubectl describe <kind>/<name> -n <ns>` | |
| `kubectl_logs` | `kubectl logs <pod> --tail=N -n <ns>` | Caps at 1000 lines per call |
| `shipit_apps_revisions` | `shipit apps revisions <app>` | Last 10 revisions |
| `cloudwatch_query` | CloudWatch Insights query | Read metrics/logs by service |
| `github_list_recent_commits` | GitHub API | Correlates with deploys |

#### Destructive (always gated through agentgate)
| Tool | Wraps | Default policy |
|---|---|---|
| `shipit_rollback` | `shipit apps rollback <app> --revision N` | `ask` |
| `kubectl_rollout_restart` | `kubectl rollout restart deployment/<name>` | `ask` |
| `kubectl_scale` | `kubectl scale deployment/<name> --replicas N` | `ask` (capped at 2x current) |

Every destructive tool implementation begins with:

```ts
const decision = await gate.requireApproval({
  agent: "devops-agent",
  action: "shipit.rollback",            // or other action id
  reason: claudeProvidedReason,         // diagnosis + justification
  metadata: { incidentId, app, ...args },
  context: { runbook: "rollback.md", alertType },
});
if (!decision.approved) {
  return { ok: false, denied: true, reason: decision.reason };
}
```

#### Escalation (no gating, no execution)
| Tool | Effect |
|---|---|
| `escalate_to_human` | Stops the loop, posts diagnosis + recommendation to the PD incident, pages the on-call SRE |
| `finish_diagnosis` | Stops the loop with a read-only summary (no fix recommended) |

### 4. Tool gating (autonomous mode vs. interactive mode)

The interactive mode relies on the **claude-code-hook** to intercept dangerous shell calls. The autonomous loop doesn't go through Claude Code, so the hook can't gate it. Instead:

- Destructive tools call `gate.requireApproval()` directly inside their implementations (see above).
- Read-only tools never call the gate — they execute immediately.
- This keeps both modes converging on the same control plane and audit log.

### 5. Output / feedback channel
- On approval + execute success → comment on the PD incident: "agentgate approved rollback of orders-api 48→47, executed at 03:14, error rate dropped to 0.2%"
- On denial → comment: "agentgate denied rollback (reason: <human reason>); next step: <agent's fallback>"
- On escalation → page the on-call SRE with a one-paragraph summary
- Full structured trace always written to agentgate audit log

## End-to-end flow (autonomous mode)

```
PagerDuty alert fires
        │
        ▼
POST /webhooks/pagerduty  (signature verified)
        │
        ▼
IncidentContext built, agent run spawned
        │
        ▼
Agent loop (Claude + tools):
  1. Read incident-response.md runbook
  2. Run read-only tools to investigate (logs, describe, recent deploys)
  3. Form diagnosis
  4. Choose ONE remediation
  5. Call destructive tool → gate.requireApproval()
        │
        ▼
agentgate control plane evaluates:
  - rule-pack policy → auto-allow / auto-deny / ask-human
  - if "ask": pauses, surfaces in dashboard + Slack
        │
        ▼
Decision returned to agent
        │
        ├─ approved → execute → verify (read-only) → comment on PD incident
        ├─ denied   → log → escalate_to_human
        └─ timeout  → log → escalate_to_human
        │
        ▼
Audit log entry persisted. Loop ends.
```

## Configuration

Single config file, `examples/devops-agent/agent-config.json`:

```jsonc
{
  "controlPlaneUrl": "http://localhost:4000",
  "anthropicApiKeyEnv": "ANTHROPIC_API_KEY",
  "pagerduty": {
    "webhookSecretEnv": "PD_WEBHOOK_SECRET",
    "serviceMapping": "./pagerduty-mapping.json"
  },
  "shipit": {
    "cluster": "unboundsecurity-cluster-nclpwi",
    "region": "us-west-2"
  },
  "limits": {
    "maxToolCallsPerIncident": 30,
    "maxWallClockSeconds": 600,
    "maxDollarsPerIncident": 2.00
  },
  "alertHandlers": {
    "crashloop": "enabled",
    "error-rate": "enabled",
    "latency": "escalate-only",
    "unknown": "escalate-only"
  }
}
```

## File map after this spec lands

```
examples/devops-agent/
├── README.md                    # existing — interactive mode docs
├── SPEC.md                      # this file
├── install.sh                   # existing — interactive mode installer
├── system-prompt.md             # existing — reused
├── claude-settings.json         # existing
├── rule-pack.json               # existing
├── runbooks/                    # existing
├── mcp-bundle/                  # existing
└── autonomous/                  # NEW
    ├── package.json
    ├── tsconfig.json
    ├── agent-config.json
    ├── pagerduty-mapping.json
    ├── src/
    │   ├── server.ts            # Fastify, /webhooks/pagerduty
    │   ├── agent.ts             # Claude tool-use loop
    │   ├── tools/
    │   │   ├── read.ts          # kubectl/shipit/cloudwatch read tools
    │   │   ├── write.ts         # destructive tools, all gated
    │   │   └── escalate.ts
    │   ├── pagerduty.ts         # signature verify, payload normalization
    │   └── audit.ts             # structured logging to agentgate
    └── fixtures/
        └── crashloop.json       # sample PD payload for offline testing
```

## v1 acceptance criteria

A demo where:
1. `node autonomous/dist/server.js --fixture fixtures/crashloop.json` runs without a real PD account
2. Agent investigates, identifies the bad revision, proposes a rollback
3. Approval shows up in agentgate dashboard at `localhost:4000` with the diagnosis as the `reason`
4. Approving in the dashboard makes the agent execute the `shipit apps rollback`
5. Denying makes the agent escalate (no execution)
6. Full trace appears in the agentgate audit log

## Open questions

1. **PD account ownership** — is there an Unbound PD account we can attach a webhook to, or should we stand up a personal one for now?
2. **Cluster auth** — does the agent runner have its own k8s/AWS service-account credentials, or does it inherit Venka's `~/.kube/config`? (For demo: developer creds. For real: dedicated SA with read + the specific writes we permit.)
3. **Rule-file loading dependency** — `rule-pack.json` notes it's planned for `claude-code-hook` v0.2. The autonomous loop doesn't need it (it talks to the control plane directly), but the policy engine does need to load these rules. Is rule-pack loading in the control plane already shipped, or does v1 require us to land that first?
4. **Timeline vs. existing roadmap** — `PLAN.md` weeks 3–4 are Python SDK + Slack approvals. Does this DevOps-agent autonomous mode slot in alongside, or replace one of those?

## Implementation order (suggested)

1. Scaffold `autonomous/` directory + Fastify webhook route + fixture replay
2. Implement read-only tools + agent loop with NO destructive tools (it can only diagnose and `escalate_to_human`)
3. Add ONE destructive tool (`shipit_rollback`) with `requireApproval` integration
4. End-to-end demo against the existing dashboard
5. Add `kubectl_rollout_restart` and `kubectl_scale`
6. Wire real PD webhook (replaces fixture mode for staging incidents)
