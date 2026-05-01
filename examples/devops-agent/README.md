# Safe DevOps Agent on agentgate

A pre-configured Claude Code experience that turns the editor into a **safety-aware DevOps engineer**. Every dangerous action routes through the agentgate control plane. Every action lands in the audit log.

You don't install a new agent. You install a **persona + opinionated config + runbooks** for Claude Code, with the agentgate hook and MCP gate already wired in.

## What you get

- A **system prompt** (`system-prompt.md`) that makes Claude Code behave like a defensive senior SRE: announces intent, prefers dry-runs, asks for approval before destructive actions, never silences alerts to "fix" them.
- A **`.claude/settings.json` template** that installs the agentgate `PreToolUse` hook and a starter MCP server bundle (filesystem, postgres, k8s, github, aws — wrapped through `mcp-gate`).
- A set of **runbooks** (`runbooks/`) Claude Code reads as project context: incident response, deploys, rollbacks, scaling, ML model promotion, capacity planning. Each one bakes in the safe sequence (read first → diagnose → propose → ask → act).
- A **rule pack** (`rule-pack.json`) of opinionated overrides for ops workflows (loaded once `claude-code-hook` supports config files in v0.2).

## 10-minute install

```bash
# 1. Make sure the agentgate control plane is running
node packages/control-plane/dist/index.js &

# 2. Install the DevOps agent persona for your Claude Code
./examples/devops-agent/install.sh

# 3. Open http://localhost:4000 (dashboard) or run `agentgate watch` in a terminal
# 4. Start a fresh Claude Code session in any repo
```

The next time you ask Claude Code to do something ops-y ("investigate why orders-api is failing", "scale the deployment", "promote model v47 to production"), it'll:
- Pull the relevant runbook into context
- Do read-only investigation silently
- Pause for your approval before any destructive write
- Log every action to agentgate's audit trail

## Try it

Open Claude Code and try:

> "Our `/api/orders` endpoint started throwing 500s ten minutes ago. Investigate and propose a fix."

The agent will follow the `incident-response.md` runbook: query metrics (silent), tail logs (silent), correlate with recent deploys (silent), propose a remediation (e.g., "scale to 6 replicas" or "roll back the last deploy"), then **wait for your approval** before doing anything destructive.

## What this demonstrates

This is the **end-to-end product story** of agentgate, in one runnable example:

- ✅ Cross-tool gating — Claude Code hook + MCP gate both in play
- ✅ Read-only operations don't get in the user's way
- ✅ Destructive operations always get a human in the loop
- ✅ Audit log captures who did what, why, and when
- ✅ A real SRE persona that knows how to do ops work safely

It's not a new agent — it's **a recipe for using existing agents safely**.

## File map

```
examples/devops-agent/
├── README.md              # this file
├── install.sh             # one-shot installer
├── system-prompt.md       # the SRE persona
├── claude-settings.json   # template for ~/.claude/settings.json
├── rule-pack.json         # opinionated rule overrides (v0.2)
├── runbooks/
│   ├── incident-response.md
│   ├── deploy.md
│   ├── rollback.md
│   ├── scale-out.md
│   ├── model-promotion.md
│   ├── capacity-planning.md
│   └── README.md
└── mcp-bundle/
    └── README.md          # which MCP servers, why, install commands
```

## What this is NOT

- ❌ Not a new agent runtime (Claude Code is the runtime)
- ❌ Not a fork of Claude Code
- ❌ Not a competing product to Devin / Cursor / Cline
- ❌ Not a model — no fine-tuning, no training data
- ❌ Not production-ready (see top-level README — agentgate itself is `v0.0.1-alpha`)
