# @agentgate/claude-code-hook

A Claude Code `PreToolUse` hook that gates dangerous tool calls (Bash, Edit, Write) through your `agentgate` control plane.

## What it does

1. Claude Code is about to run a tool (`Bash "rm -rf node_modules"`, `Edit /etc/passwd`, etc.).
2. This hook fires first, reads the tool call from stdin.
3. Checks the call against a built-in ruleset of dangerous patterns (recursive deletes, force pushes, terraform apply, drops, edits to `.env`, etc.).
4. If safe — exits 0, Claude proceeds.
5. If dangerous — fires an approval request to the agentgate control plane and **blocks** until a human approves or denies via the dashboard. Exit code 2 (block) or 0 (allow) is returned to Claude Code.

## Install

In `~/.claude/settings.json` (or project-level `.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/agentgate/packages/claude-code-hook/dist/index.js"
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code (or start a new session) to pick up the hook.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `AGENTGATE_URL` | `http://localhost:4000` | Control plane base URL |
| `AGENTGATE_AGENT` | `claude-code` | Agent identity recorded in audit log |
| `AGENTGATE_TIMEOUT_MS` | `300000` (5 min) | How long to wait for approval before blocking |
| `AGENTGATE_FAIL_OPEN` | unset | If `1`, allow tool calls when the control plane is unreachable. Default is fail-closed. |

## Default-dangerous patterns (subset)

- `rm -rf`, `rm` near `/`, `mkfs`, `dd of=/dev/`, fork bomb
- `git push --force`, push to `main`/`master`/`prod`, `git reset --hard`, history rewrites
- `terraform apply` / `destroy`
- `kubectl delete|drain|patch|replace|apply -f`, `helm uninstall`
- `aws s3 rb`, `aws s3 rm --recursive`, `ec2 terminate-instances`, `rds delete-db`
- `gcloud … delete`, `az … delete`
- SQL: `DROP TABLE`, `TRUNCATE`, `DELETE FROM` without `WHERE`
- `npm publish`, `cargo publish`, `gh release create`, `gh pr merge --admin`
- `curl … | bash`, `chmod 777`, `docker system prune -a`
- File edits to `.env*`, `secrets/`, `credentials/`, private keys, `terraform.tfstate`, paths under `prod/`

See `src/rules.ts` for the full list. Rules are not yet user-configurable (planned for v0.2).
