# agentgate

> **An AI DevOps engineer you can give prod access to.** agentgate watches your systems, catches incidents, and fixes them — but it **freezes before any risky action and waits for a human**, with a rollback plan and a full audit trail for every step.

It's safe to run because every action it takes flows through a governance control plane — policy, approval, kill-switch, audit. That same control plane gates **any** agent that speaks the Model Context Protocol (Claude Desktop, Cursor, Cline, or your own) with **zero changes to agent code.** The agent is the product; the control plane is why you can trust it in production.


```bash
npm install
npm run demo            # terminal 1: control plane + dashboard on :4000
npm run demo:incident   # terminal 2: the AI DevOps engineer, live
```

The agent watches a service, a bad deploy lands, the error rate spikes — and it
catches it **on its own**, diagnoses the cause, and proposes a rollback.Then it
**stops** and waits for you to approve at
[http://localhost:4000/?tab=agents](http://localhost:4000/?tab=agents). Approve,
and it rolls back and recovers the service. Every step — detect, diagnose,
approve, act — lands in the audit log. The agent does the work; you keep control.

## The control plane underneath — gate any MCP agent (no agent code)

The same governance layer that makes our agent safe will gate **any** agent you already run. `@agentgate/mcp-gate` transparently wraps any MCP server over stdio. The MCP client (Claude Desktop, Cursor, Cline, …) connects to the gate instead of the server; the gate forwards everything except `tools/call`, which it intercepts → classifies risk → enforces policy / requests approval → forwards or blocks.

> **Running from a clone?** Until the packages are on npm, use the repo: `npm install && npm run build`, then call the local binaries (e.g. `node packages/mcp-gate/dist/cli.js …`) or `npm link`. The `npx @agentgate/...` commands below are the published-package UX.

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

## Gate Claude Code in one command

To gate a *real* coding agent — one that actually runs `rm -rf`, force-pushes, edits
`.env`, drops tables — install the PreToolUse hook. No JSON editing:

```bash
npx @agentgate/control-plane          # dashboard on :4000 (leave running)
npx @agentgate/claude-code-hook init  # merges the hook into ~/.claude/settings.json
```

Restart Claude Code. Now when it tries something destructive, the call **freezes**
before it runs and waits for you to approve in the dashboard. Reads and safe edits
pass through untouched. (`init --project` writes a project-local config; `init --local`
points at a source checkout for pre-publish testing.)

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

## Security model & trust boundary

Be clear-eyed about what this is: **a developer-adopted safety net with an audited, identity-bound approval step — not an unbypassable security perimeter.** A determined agent or operator with local machine access can route around any client-side control. agentgate's job is to make the *default* path safe, make every gated action *require a named human*, and make the record *tamper-evident*. Within that boundary:

- **Authentication is required for decisions.** The approver's identity comes from an authenticated principal (bearer token), never from request-body free-text. You cannot stamp an approval with someone else's name, and the requester cannot approve their own request.
- **Two modes.** *Dev mode* (no tokens) runs **loopback-only** and stamps decisions with a non-forgeable local identity — zero-config for a single operator. *Team mode* (set `AGENTGATE_TOKEN`, `AGENTGATE_AGENT_TOKEN`, and/or `AGENTGATE_TOKENS`) requires a bearer on every `/v1` request and is the **only** way to bind a non-loopback interface — the server refuses otherwise.
- **The audit log is tamper-evident.** Every entry is hash-chained; `GET /v1/audit/verify` recomputes the chain and reports the first mutated row. Secrets/PII in tool inputs are **redacted before write**, so the log is not itself a credential store.
- **Fail-closed.** If the control plane is unreachable, the hook **blocks** — there is no client-side env-var that flips it to allow. (An outage-allow policy belongs on the server, role-gated, not in a developer's shell.)
- **Sensible default gating.** Out of the box the gate pauses only **high-severity / irreversible** actions, so routine writes don't drown you in prompts. Opt into stricter gating with `AGENTGATE_MIN_SEVERITY=medium` (hook) / `--gate-medium` (mcp-gate), or gate everything with `--gate-all`.
- **Shadow mode.** `AGENTGATE_SHADOW=1` (hook) / `--shadow` (mcp-gate) logs what *would* have been gated and forwards it — turn it on for a week, read `GET /v1/shadow`, see your real false-positive rate before enforcing.

For production, also set `AGENTGATE_SIGNING_SECRET` so the credential-signing key lives outside the database it protects.

## Roadmap

See [PLAN.md](./PLAN.md) for the roadmap and product direction.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
