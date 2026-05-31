# agentgate

> The governance gateway for AI agents. Every tool call your agents make in production flows through one control plane — policy, approval, audit, kill-switch — with **zero changes to agent code.**

Think of it as a **firewall for MCP**: agents speak the Model Context Protocol to reach databases, cloud infra, payment APIs, and customer data. `agentgate` sits in front of those tool calls, classifies risk, enforces policy, and records everything.

## Why

In 2026, AI agents routinely get write access to production: coding agents push to repos, support agents issue refunds, ops agents run shell commands. Telling an agent "don't do X" in a prompt fails ~5% of the time, and that 5% is an incident.

IAM, RBAC, and approval tooling assumed the actor was a human or a stable service. Agents are non-deterministic actors with derived intent and shifting credentials. They need their own control layer — one that sits at the point where intent becomes action: **the tool call.**

## The gateway (start here — no agent code)

`@agentgate/mcp-gate` transparently wraps any MCP server over stdio. Your MCP client (Claude Desktop, Cursor, Cline, …) connects to the gate instead of the server; the gate forwards everything except `tools/call`, which it intercepts → classifies risk → enforces policy / requests approval → forwards or blocks.

```
MCP client  <--stdio-->  mcp-gate  <--stdio-->  any MCP server
                            │
                            └── policy · approval · audit · kill-switch
```

Wrap any server in one line:

```bash
agentgate-mcp-gate --agent stripe-bot -- npx -y @stripe/mcp
```

### See it in 60 seconds

```bash
npm install
npm run demo            # terminal 1: control plane + dashboard on :4000
npm run demo:mcp        # terminal 2: drive an MCP client through the gate
```

The demo makes two tool calls from the **same unmodified client**:

- `list_users()` — read-only → **waved through**, no approval.
- `drop_table({ table: "users" })` — destructive → **frozen** until you approve at
  [http://localhost:4000/?tab=agents](http://localhost:4000/?tab=agents).

Approve it and watch the call complete. Every action — allowed, denied, or pending — lands in the audit log.

## Wrap your own server in 5 minutes (zero code)

You don't change your agent. You change one line of MCP **config** — point your client at the gate instead of the server, and let the gate spawn the server.

**1. Start the control plane** (this is the dashboard you'll approve from):

```bash
npx @agentgate/control-plane     # dashboard on http://localhost:4000
```

**2. Wrap a server from the command line** to try it immediately:

```bash
# before: npx -y @stripe/mcp
# after:  the same server, now gated
npx @agentgate/mcp-gate --agent stripe-bot -- npx -y @stripe/mcp
```

**3. Or wire it into your MCP client** (Claude Desktop / Cursor / Cline). In your
`mcpServers` config, wrap the server command with the gate:

```jsonc
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": [
        "@agentgate/mcp-gate", "--agent", "stripe-bot",
        "--",                       // everything after this is your real server
        "npx", "-y", "@stripe/mcp"
      ]
    }
  }
}
```

That's it. Your agent now runs exactly as before — but every destructive `tools/call`
pauses in the dashboard until you approve it, and everything is audited. Tune what
gets gated with `--allow`, `--deny`, or `--gate-all`.

## What's in the box

| Package | What it does |
| --- | --- |
| `@agentgate/mcp-gate` | **The gateway.** Wraps any MCP server; routes tool calls through the control plane. Zero agent code. |
| `@agentgate/claude-code-hook` | PreToolUse hook that gates dangerous Claude Code tool calls through agentgate. |
| `@agentgate/control-plane` | Fastify + SQLite server: REST API, server-sent events, policy engine, audit log, dashboard. |
| `@agentgate/sdk` | TypeScript SDK with one primitive — `requireApproval()` — for gating custom actions in your own code. |
| `@agentgate/cli` | Approve / deny agent actions from the terminal. |

## Dashboard

A single-page UI on the control plane:

- **Live** — pending approvals + a real-time audit log.
- **Agents** — every agent seen, who's running now, who's quarantined, and per-agent approval counts. The cockpit you open first.
- **Demo** — five one-click scenarios that spawn synthetic agents trying risky things.

## The SDK (custom, in-code gating)

When you control the agent's code and want to gate a *non-MCP* action (a Stripe refund, a raw SQL statement), call the SDK directly:

```ts
import { AgentGate } from "@agentgate/sdk";

const gate = new AgentGate({ baseUrl: "http://localhost:4000", agent: "support-bot" });

const decision = await gate.requireApproval({
  action: "stripe.refund",
  reason: "Customer requested refund for order #1234",
  metadata: { amount: 250, customer: "cus_abc" },
});

if (decision.approved) {
  // proceed
} else {
  // stop, log, surface to user
}
```

The gateway and the SDK share one control plane, one policy engine, one audit log.

## Policy

Rules in the control plane evaluate every gated action and can **allow**, **deny**, **require approval**, or **quarantine** the agent — by agent pattern, action pattern, and condition. Two of the demo scenarios trip seeded policies so you can watch enforcement happen with no human in the loop.

## Roadmap

See [PLAN.md](./PLAN.md) for the roadmap and product direction.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
