# DevOps Agent — Autonomous (PagerDuty) mode

Companion to the interactive Claude Code persona in `../`. When PagerDuty fires
an alert, this service spawns a headless `claude -p` run with the SRE persona,
the incident-response runbook, and the alert details. The existing
`claude-code-hook` gates any destructive command through agentgate exactly like
in interactive mode.

## What it adds beyond the interactive setup

| | Interactive | Autonomous (this) |
|---|---|---|
| Trigger | Human types in Claude Code | PagerDuty webhook |
| Runtime | Claude Code | Claude Code (headless `-p`) |
| Persona | `system-prompt.md` | same |
| Runbooks | loaded by Claude Code | injected into prompt |
| Gating | claude-code-hook → agentgate | claude-code-hook → agentgate |
| Audit | agentgate session opened by hook | agentgate session opened by this server |

Same safety boundary, different ignition source.

## Prerequisites

1. agentgate control plane running on `localhost:4000`
   ```bash
   node packages/control-plane/dist/index.js &
   ```
2. Claude Code installed and on `$PATH`, with the DevOps-agent persona installed
   (run `../install.sh` first)
3. `kubectl`, `shipit`, and AWS credentials configured for whichever target
   cluster the agent should act against
4. `ANTHROPIC_API_KEY` exported (Claude Code reads this directly)

## Quickstart — fixture mode (no PagerDuty account needed)

```bash
# from repo root
npm install
npm run build --workspace=@agentgate/example-devops-agent-autonomous

# fire a fake CrashLoopBackOff incident
npm run fixture --workspace=@agentgate/example-devops-agent-autonomous
```

You should see:
1. Server prints `[fixture] dispatching incident PINC-2026-0506-CL-42`
2. agentgate dashboard at http://localhost:4000 shows a new session for `devops-agent-autonomous`
3. Claude Code investigates (read-only kubectl/shipit calls)
4. When it proposes a destructive action (e.g. `shipit apps rollback orders-api --revision N`),
   an approval appears in the dashboard with the agent's diagnosis as the reason
5. Approve → action runs. Deny → agent stops with the denial reason.

## Live PagerDuty webhook mode

```bash
export PD_WEBHOOK_SECRET=$(pbpaste)   # the secret from PagerDuty Integrations
npm run start --workspace=@agentgate/example-devops-agent-autonomous

# expose locally with cloudflared / ngrok / tailscale funnel:
cloudflared tunnel --url http://localhost:4100
# point your PagerDuty webhook at https://<tunnel>/webhooks/pagerduty
```

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `4100` | HTTP listen port |
| `AGENTGATE_URL` | `http://localhost:4000` | Control plane URL |
| `PD_WEBHOOK_SECRET` | *(required for live)* | HMAC-SHA256 secret from PagerDuty |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI |
| `ANTHROPIC_API_KEY` | *(required)* | Read by Claude Code |

`pagerduty-mapping.json` maps PagerDuty service names → Shipit app + namespace.

## Files

```
autonomous/
├── package.json
├── tsconfig.json
├── pagerduty-mapping.json   # service → app
├── fixtures/
│   └── crashloop.json       # sample PD payload
└── src/
    ├── server.ts            # Fastify + --fixture replay
    ├── pagerduty.ts         # signature verify + payload normalization
    └── incident.ts          # spawn `claude -p`, manage agentgate session
```

## What's deliberately NOT here (yet)

- No retry / dead-letter logic — PD will retry on non-2xx, that's enough for v1
- No idempotency on incidentId — re-firing the same fixture spawns a new session
- No real-time output back to PagerDuty (planned: post diagnosis to incident timeline)
- No budget enforcement (model spend / wall-clock) — relies on Claude Code's defaults

See `../SPEC.md` for the full v1 design and roadmap.
