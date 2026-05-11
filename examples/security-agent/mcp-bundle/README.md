# MCP bundle for the Security Agent

The security agent does most of its work with read tools the user already has — `git`, `rg`, `kubectl`, cloud CLIs. MCP servers add typed read access to specific systems and a uniform audit trail when wrapped through `mcp-gate`.

This bundle is **opinionated, not exhaustive.** Add servers as you adopt them; remove ones you don't use. Each one runs as a child of `mcp-gate`, so destructive tool calls are intercepted and require human approval.

## Recommended

### `filesystem` (enabled by default in `claude-settings.json`)
- **Why**: code review, manifest review, secret scans — most security work starts by reading files
- **Read tools**: `read_text_file`, `list_directory`, `search_files`
- **Write tools**: `write_file`, `edit_file`, `move_file`, `create_directory` — all gated
- **Scope**: pointed at `$HOME` by default; narrow this to your repo root if you can

### `github`
- **Why**: PR review, audit-log queries, secret-scanning results, repo settings audit
- **Auth**: `GITHUB_PERSONAL_ACCESS_TOKEN` env var; least-privilege the PAT (read:org + read:repo + audit_log:read for org-level work)
- **Read tools**: list PRs, get diffs, list workflow runs, get audit log, list secrets (names only)
- **Write tools**: comment on PR, set secret, create/update issue — all gated

### `postgres` (read-only role)
- **Why**: query app logs / audit tables / user tables during incident response
- **Auth**: a dedicated **read-only** DB user — do not point this at the app's write role
- **Scope**: read-only by user design; mcp-gate is a second layer, not the first

## Optional — enable per engagement

### `slack`
- **Why**: pull message history into an incident channel; read audit log
- **Caution**: scope the bot user tightly; default Slack tokens have surprising blast radius

### `aws` (read-only role)
- **Why**: CloudTrail queries, IAM listing, S3 audits
- **Auth**: a dedicated IAM role with `ReadOnlyAccess` + `SecurityAudit`; do not reuse a dev/SRE role

### `kubernetes`
- **Why**: cluster-state queries during an incident; manifest review
- **Auth**: a dedicated ServiceAccount with cluster-wide `get`/`list` and no writes

## Servers we explicitly do NOT recommend

- **Anything that lets the agent run arbitrary shell on a remote host** (e.g. SSH-via-MCP). Use a runbook + approved shell access instead — keeps the audit trail and the gate together.
- **MCP servers that re-implement what `gh` / `aws` / `kubectl` already do**, unless they add typed structure the agent benefits from. Extra trust roots, extra surface.

## Adding a new server

1. Pick an MCP server (or write one)
2. Add it to `claude-settings.json` under `mcpServers`, wrapped through `mcp-gate`:

   ```jsonc
   "<name>-via-agentgate": {
     "command": "node",
     "args": [
       "AGENTGATE_HOME/packages/mcp-gate/dist/index.js",
       "--agent", "<name>-mcp",
       "--",
       "<the actual server command and args>"
     ]
   }
   ```

3. Decide which of that server's tools are destructive and update the rule pack accordingly
4. Restart Claude Code
