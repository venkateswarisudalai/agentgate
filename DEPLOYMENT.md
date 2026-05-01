# Deploying agentgate

How to actually get this in front of every agent that touches production — for one dev, one team, or one company.

There are two questions: (1) *technically*, where do you insert the gate for each agent? and (2) *strategically*, in what order do you roll it out?

---

## 1. The integration matrix — where the gate sits per agent

| Agent / runtime | Gate point | Status in this repo |
|---|---|---|
| **Claude Code** (Anthropic CLI) | `PreToolUse` hook in `~/.claude/settings.json` | ✅ `packages/claude-code-hook` |
| **Claude Desktop** | MCP gate proxy (Claude Desktop is MCP-native) | ✅ `packages/mcp-gate` |
| **Cursor** (background agents, Composer with MCP) | MCP gate proxy for MCP tools. For non-MCP tool calls in Composer, today there's no public hook — track Cursor's hooks API. | ✅ via `mcp-gate` for MCP tools |
| **Cline / Roo Code / Continue.dev** | MCP-native — wrap their MCP servers via `mcp-gate` | ✅ via `mcp-gate` |
| **Codex CLI** (OpenAI) | Tool-call hook (similar to Claude Code; hook system is newer — track OpenAI's spec) | ⏳ planned |
| **Aider** | Wrap the LLM client; intercept tool calls in their planner | ⏳ planned |
| **Devin** (Cognition) | Webhook on tool execution via their API | ⏳ planned |
| **LangGraph / LangChain agents** | SDK helper: `gate.wrapTool(tool)` mutates a tool's `func` to call `requireApproval` first | ⏳ planned |
| **Mastra / Vercel AI SDK / OpenAI Agents SDK** | Same SDK helper pattern | ⏳ planned |
| **Custom Python agents** | Python SDK with `@requires_approval` decorator | ⏳ planned (week 3) |
| **Any agent calling any MCP server** | `mcp-gate` proxy in front of the MCP server | ✅ `packages/mcp-gate` |

**The two highest-leverage gates already exist:** Claude Code hook and the MCP gate proxy. Together they cover the majority of real agents in production today.

---

## 2. Topology — where each piece runs

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          the user's machine                             │
│                                                                         │
│  Claude Code ──PreToolUse hook──┐                                       │
│  Cursor MCP   ──gate proxy──────┤                                       │
│  Cline MCP    ──gate proxy──────┤                                       │
│  Custom agent ──SDK call────────┤                                       │
│                                  │                                      │
│                                  ▼                                      │
│                        ┌──────────────────┐                             │
│                        │  control plane   │  http://localhost:4000      │
│                        │  (single binary) │  SQLite, Fastify, SSE       │
│                        └────────┬─────────┘                             │
│                                 │                                       │
│                       ┌─────────┴─────────┐                             │
│                       ▼                   ▼                             │
│            web dashboard           agentgate CLI                        │
│            (browser)               (terminal y/n)                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**For a team:** the control plane moves to a shared host. Hooks/gates from every dev machine point to it.

**For an org:** add Postgres (replace SQLite), SSO (Clerk/WorkOS), Slack notifier, and an audit-log forwarder to the company SIEM.

---

## 3. Solo dev deployment (5 minutes)

```bash
git clone <repo> && cd venka && npm install && npm run build

# 1. Start the control plane (port 4000)
node packages/control-plane/dist/index.js
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/agentgate/packages/claude-code-hook/dist/index.js"
      }]
    }]
  }
}
```

To wrap an MCP server in `~/.claude/claude_desktop_config.json` (or your MCP client's equivalent):

```json
{
  "mcpServers": {
    "stripe": {
      "command": "node",
      "args": [
        "/absolute/path/to/agentgate/packages/mcp-gate/dist/index.js",
        "--agent", "stripe-mcp",
        "--",
        "npx", "-y", "@stripe/mcp"
      ]
    }
  }
}
```

That's it. Watch approvals from a second terminal:

```bash
node packages/cli/dist/index.js watch
```

Or in the browser at `http://localhost:4000`.

---

## 4. Team deployment

Run the control plane on shared infra. One Docker image, one DB.

```yaml
# docker-compose.yml (illustrative — not yet shipped)
services:
  control-plane:
    image: agentgate/control-plane:latest
    ports: ["4000:4000"]
    environment:
      AGENTGATE_DB: /data/agentgate.db
      LOG_LEVEL: info
    volumes:
      - agentgate-data:/data
volumes:
  agentgate-data:
```

Distribute the Claude Code hook config via:
- **A team dotfiles repo** every dev clones (lowest friction)
- **A bootstrap script** that runs once: `curl agentgate.dev/install | bash`
- **Project-level `.claude/settings.json`** committed to each repo (per-project policies)

Set env in dev shells:
```bash
export AGENTGATE_URL=https://agentgate.internal.company.com
export AGENTGATE_USER="$USER@$(hostname)"
```

Approvers can be:
- Devs themselves on a different terminal (`agentgate watch`)
- A pinned channel in Slack (week 4 — Slack notifier with inline approve/deny)
- The dev's own tech lead via the dashboard

---

## 5. Org deployment (the buyer wants this)

Replaces every "✅" above with proper enterprise plumbing:

| Layer | Solo / team | Org |
|---|---|---|
| DB | SQLite (single file) | Postgres + read replicas |
| Auth | none (loopback only) | SSO via WorkOS/Clerk, OIDC |
| Multi-tenancy | none | Org / project / API-key model |
| Approvers | local dashboard | Slack channel + escalation policies + role-based queues |
| Audit log | local | Forwarded to SIEM (Splunk, Datadog, S3 archive) |
| Settings distribution | dotfiles | MDM (Jamf, Kandji) push of `~/.claude/settings.json` so devs can't disable the hook |
| Policy | hardcoded heuristics | Per-team / per-project YAML policy with `allow_if`, `deny_if`, `require_approval_if` |
| HA | single Node process | Multiple control-plane replicas behind a load balancer |
| Network | loopback | TLS, mTLS for hook → control plane, behind corp VPN |

**Most of this is week 5–7 work.** Today's repo deliberately stops at "team deployment" so we can ship and learn first.

---

## 6. Strategic deployment — the GTM phases

How to go from one workstation to many. Build trust at each phase before pushing to the next.

### Phase 0 — Self (this week)

- Install agentgate on **your own** machines.
- Use it for everything you do in Claude Code for at least 7 days.
- Write down every false positive (rules that fired when they shouldn't) and every false negative (dangerous things that *didn't* fire).
- Tune until you'd actually be sad if the hook were removed.

**Goal:** dogfood enough to make the rules and the UX honest.

### Phase 1 — OSS launch (next 2–4 weeks)

- Apache 2.0 LICENSE, CONTRIBUTING, docs site, Docker compose.
- Post:
  - **Hacker News** — show HN format, lead with the 30-second demo gif, not the pitch
  - **r/ClaudeAI, r/cursor, r/LocalLLaMA**
  - **AI Engineer Discord, Latent Space, MCP Discord**
  - **X/Twitter dev community** with a screencast of a denied `rm -rf`
- Optimize for **time-to-first-blocked-command** — under 5 minutes from `git clone` to seeing a real protection event.
- Pin a #design-partners thread on the repo. Take 5 design partners — companies running Claude Code or Cursor with at least one prod-touching agent.

**Goal:** prove engineers will *adopt voluntarily*, not because their CISO forced them.

### Phase 2 — Team adoption (weeks 4–10)

- Ship the **policy engine** so the easy 90% auto-decides without humans (week 2 already planned).
- Ship the **Slack notifier** so approvals don't require leaving the channel (week 4).
- Add **per-project policy files** so each team's rules can live in the repo.
- Land integrations for **Cursor, Devin, LangGraph** so a team's mixed-agent fleet is covered uniformly.

**Goal:** the moment a second engineer at a design-partner company says "we should turn this on for everyone."

### Phase 3 — Org adoption (months 3–6)

- Ship **multi-tenant + SSO + audit-log forwarding** (week 5+).
- Build the **CISO/audit dashboard** view — same data, different lens. Compliance reports for SOC2, HIPAA, EU AI Act.
- Hire your first non-engineer: a security-savvy field engineer who can run technical-buyer conversations.
- Publish **incident postmortems** of "agent did X, agentgate caught it, here's the audit trail" — stories sell governance more than features do.

**Goal:** be the default agent control plane in any company that has agents in prod.

### Phase 4 — Platform (months 6+)

- Open the policy engine and rule schema for community contributions.
- Build a **policy marketplace** (verified rule packs for SOC2, HIPAA, FedRAMP).
- Ship a **hosted cloud** for teams that don't want to self-host.
- Charge enterprise tier (priced per seat or per audit-log retention).

**Goal:** the category-defining product. Datadog for agent actions.

---

## 7. What deployment looks like for the **buyer** (the slide they'll see)

When you eventually pitch a CISO or VP of Eng:

> **Today, your engineers run AI agents (Claude Code, Cursor, Devin, internal copilots) that have credentials to production. You have:**
> - No central record of what these agents did
> - No way to require human approval for destructive actions
> - No policy enforcement across the fleet
> - No audit trail for SOC2 / HIPAA / EU AI Act
>
> **agentgate gives you all four, with one Docker container and a one-line config in each agent.**
>
> Engineers install it themselves because it stops *their* workstation from getting nuked. You get the audit log and policy engine for free.

Bottom-up adoption is the entire moat. **Make Phase 1 perfect before worrying about Phase 4.**
