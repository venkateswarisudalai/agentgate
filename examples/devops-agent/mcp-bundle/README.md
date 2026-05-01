# MCP server bundle (recommended for DevOps work)

These are MCP servers commonly useful for DevOps/MLOps workflows. Each one is wrapped through `agentgate-mcp-gate` so destructive tool calls require approval.

| MCP server | Why DevOps wants it | Install |
|---|---|---|
| `@modelcontextprotocol/server-filesystem` | Read configs, edit code, walk directories | `npx -y @modelcontextprotocol/server-filesystem <root>` |
| `@modelcontextprotocol/server-postgres` | Query app DBs, inspect migrations, read slow-query logs | `npx -y @modelcontextprotocol/server-postgres <url>` |
| `@modelcontextprotocol/server-github` | List PRs, file issues, look up commits | `npx -y @modelcontextprotocol/server-github` (needs `GITHUB_PERSONAL_ACCESS_TOKEN`) |
| `mcp-server-kubernetes` (community) | List pods, describe resources, tail logs, scale deployments | `npx -y mcp-server-kubernetes` |
| `aws-mcp-server` (community) | Query CloudWatch, describe EC2/RDS/S3, etc. | varies — see project README |
| `mcp-server-datadog` (community) | Query metrics, list monitors, fetch dashboards | varies |
| `mcp-server-stripe` | Refund / customer lookup (if your DevOps work touches billing) | `npx -y @stripe/mcp` |

## Wrapping pattern

For each MCP server you add, the wrapping looks like:

```jsonc
{
  "mcpServers": {
    "<friendly-name>-via-agentgate": {
      "command": "node",
      "args": [
        "/abs/path/to/agentgate/packages/mcp-gate/dist/index.js",
        "--agent", "<agent-id-in-audit-log>",
        "--",
        "<the-real-mcp-server-command>", "<its-args>"
      ]
    }
  }
}
```

The `--agent` value shows up in the audit log so you can tell which underlying MCP server caused a given approval.

## Default behavior

`mcp-gate` uses heuristics on the tool name and arguments:
- Read-only verbs (`list`, `get`, `read`, `describe`, `query`, ...) → pass through silently
- Mutating verbs (`create`, `update`, `set`, ...) → require approval
- Destructive verbs (`delete`, `drop`, `destroy`, `remove`, `revoke`, `terminate`, ...) → require approval, marked HIGH risk
- Dangerous arg keys (`force=true`, `production=true`, `cascade=true`, ...) → escalate severity

Override with:
- `--allow tool1,tool2` — never gate these tools
- `--deny tool1,tool2` — never allow these tools
- `--gate-all` — gate every tools/call regardless of heuristics

## What's missing

- HTTP/SSE MCP transport (only stdio supported in v0)
- `resources/*` and `prompts/*` gating (only `tools/call` is intercepted today)
- Per-server custom rules (planned for v0.2 with the rule pack feature)
