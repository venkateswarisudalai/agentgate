# Replay: "AI agent deletes the company database in 9 seconds"

A faithful replay of the canonical incident class — most recently seen in the **Cursor / Claude-powered coding agent** that wiped a company's production database (and its backups) in seconds, with no human in the loop.

This script makes that exact failure mode runnable on your laptop, **with agentgate in the path.** You see what would have happened. You see what gating gives you.

## What it does

The "agent" (`cleanup-bot-prod`) reasons its way into a four-step destructive sequence:

| # | Action | Severity |
|---|---|---|
| 1 | `DROP DATABASE test` (intentional cleanup) | high |
| 2 | `DROP DATABASE production` (over-generalization — DISASTER) | high |
| 3 | `aws s3 rm s3://acme-prod-backups/ --recursive` (so backups "don't confuse anyone") | high |
| 4 | `terraform destroy -auto-approve` (to "save costs" since the DB is empty now) | high |

In the real incident, **none of these were gated**. The agent ran the entire sequence in 9 seconds. The company lost the data and the backups. Recovery was impossible.

In this replay, every step pauses for human approval through agentgate. You see the full impact card for each — what it does, the consequences, whether it's recoverable. **Deny step 2 to save the company.**

## Run it

In one terminal — start the control plane:
```bash
node packages/control-plane/dist/index.js
```

In a second terminal — open the dashboard or the CLI watcher:
```bash
open http://localhost:4000          # browser dashboard
# OR
node packages/cli/dist/index.js watch  # terminal CLI
```

In a third terminal — run the replay:
```bash
npm run start --workspace=@agentgate/example-db-deletion-replay
```

You'll see the agent narrate each step. Decide each one in the dashboard or CLI:
- **Approve all 4** → the script ends with the "in the real incident, the company is gone" verdict
- **Deny step 2** → "CRISIS AVERTED at step 2/4". The script exits with code 2.

Either way, every action is permanently recorded in the agentgate audit log.

## Why this exists

Every successful safety/security product has one canonical "this would have prevented X" example. For agentgate, this is it. The replay turns the abstract pitch ("we gate destructive AI agent actions") into something **a viewer can run, click through, and feel** in 90 seconds.

It also doubles as:
- The **screencast** for the project README and Show HN post
- A **regression test** — if a future change breaks the gate flow, this script breaks visibly
- A **template** for replaying other public incidents (Replit prod-DB delete, GitHub/Cursor secret leaks, etc.) as their own folders

## Disclaimer

This script does not actually run any destructive command. It only emits gated approval requests describing what an agent *would* have done. Safe to run on any machine.
