# agentgate

> Production safety for AI agents. Stop your agent from dropping prod.

`agentgate` is a control plane that sits between AI agents and the dangerous things they can touch — production databases, cloud infra, money, customer data. Risky actions pause and wait for human approval. Every action is recorded in an audit log.

It's `sudo` for agents.

## Why

In 2026, AI agents are routinely given write access to production systems: coding agents push to repos, support agents issue refunds, ops agents run shell commands. Telling an agent "don't do X" in a prompt fails ~5% of the time, and that 5% is an incident.

The existing IAM, RBAC, and approval tooling assumed the actor was a human or a stable service. Agents are non-deterministic actors with derived intent and shifting credentials. They need their own control layer.

## What's in v0

- `@agentgate/sdk` — TypeScript SDK with one primitive: `requireApproval()`.
- `@agentgate/control-plane` — Fastify + SQLite server. REST API, server-sent events, audit log.
- Dashboard — single-page web UI for approving/denying actions in real time.
- Example — a "dangerous agent" that demonstrates the full loop.

## Quickstart

```bash
# install + build
npm install
npm run build

# start control plane (port 4000)
npm run start --workspace=@agentgate/control-plane

# in another terminal, open the dashboard
open http://localhost:4000

# in a third terminal, run the example agent
npm run example
```

The agent will pause. Approve it in the dashboard and watch it proceed.

## SDK usage

```ts
import { AgentGate } from "@agentgate/sdk";

const gate = new AgentGate({ baseUrl: "http://localhost:4000", agent: "support-bot" });

// before any destructive action:
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

## Roadmap

See [PLAN.md](./PLAN.md) for the 8-week roadmap and product direction.

## License

Apache 2.0 (planned for week 6 OSS release).
