# Contributing to agentgate

Thanks for your interest. agentgate is a young project; we move fast and are happy to take focused contributions, especially:

- New rules for `packages/claude-code-hook/src/rules.ts` (with parsed `describeImpact`)
- New agent integrations under `packages/` (Cursor, Devin, LangGraph, etc.)
- Bug reports with a minimal repro
- UX improvements to the dashboard or CLI

## Quick start

```bash
git clone https://github.com/your-github-org/agentgate
cd agentgate
npm install
npm run build

# start the control plane
node packages/control-plane/dist/index.js

# in another terminal, watch approvals
node packages/cli/dist/index.js watch

# in a third terminal, fire the demo agent
node examples/dangerous-agent/dist/index.js
```

## Repo layout

```
packages/
  sdk/              TypeScript SDK — requireApproval()
  control-plane/    Fastify + SQLite + dashboard host
  cli/              terminal CLI: agentgate watch/list/show/approve/deny/audit
  claude-code-hook/ Claude Code PreToolUse hook
  mcp-gate/         MCP server proxy (sits in front of any MCP server)
examples/
  dangerous-agent/      fake support bot demoing the SDK
  fake-mcp-server/      tiny MCP server demoing mcp-gate
```

## Conventions

- **TypeScript everywhere.** Strict mode. No `any` unless you really mean it.
- **Tests are encouraged but not yet required for v0.0.x.** Once we hit v0.1 we'll bring in vitest.
- **No new runtime dependencies without discussion.** Each dep is supply chain risk.
- **Format:** match the surrounding code; we don't ship a formatter config yet.

## Submitting a PR

1. Fork, branch off `main`.
2. Keep PRs small and focused. Big rewrites get bounced back.
3. In the PR description: what problem are you solving, how did you test it, any tradeoffs.
4. CI must pass (`npm install && npm run build`).
5. By submitting a PR you agree your contribution is licensed under the project's [Apache 2.0](./LICENSE) license.

## Adding a new rule (claude-code-hook)

A rule looks like:

```ts
{ id: "my-rule", category: "data", severity: "high",
  description: "Short tag",
  pattern: /\bdangerous-cli\s+--bad\b/,
  describe: (cmd, m) => ({
    headline: "What this would do, in plain English.",
    consequences: ["Bullet 1", "Bullet 2"],
    recoverable: "no",
    targets: { /* parsed from the command */ },
  }) },
```

Aim for low false-positive rate. We'd rather miss the long tail than annoy users into disabling the hook.

## Reporting security issues

Please don't open public issues for security-relevant bugs. See [SECURITY.md](./SECURITY.md).

## Code of conduct

Be excellent to each other. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
