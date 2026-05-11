# Security Agent — Specification

**Status:** v1 design
**Owner:** Venka
**Depends on:** `@agentgate/sdk`, `@agentgate/control-plane`, `@agentgate/claude-code-hook`, `@agentgate/mcp-gate`, `@agentgate/pkg-scan`, `@agentgate/iac-scan`

## Goal

A defensive AI Application Security Engineer that reviews code, triages vulnerabilities, responds to incidents, and proposes fixes — with every dangerous action gated through agentgate.

v1 ships as an **interactive persona** for Claude Code, mirroring the shape of `examples/devops-agent/` (interactive mode). Autonomous mode (advisory-bot on PRs / scheduled scans) is a v2 follow-up.

## Why this shape

- **Reuse, don't replace.** The Claude Code hook already gates dangerous shell, edits, and HTTP writes. The security agent adds a persona, security-tuned runbooks, and a rule pack — not a new runtime.
- **agentgate is the safety boundary, not the agent.** The agent stays a thin persona + runbook + rule pack. All "is this safe to do" logic lives in the control plane.
- **Authorization-first.** The system prompt's authorization boundary is enforced by social contract (system prompt) and structurally (the gate denies actions against unauthorized targets when the user denies the approval).

## Non-goals (v1)

- Autonomous offensive testing — every write goes through `requireApproval`, no exceptions.
- Exploit generation against third-party systems — the persona refuses these.
- Replacing a SOC / SIEM / EDR — this is a workbench for an engineer, not a detection pipeline.
- Customer-data forensics — out of scope; escalate per `system-prompt.md` §"explicitly NOT competent at".
- Compliance reporting (SOC2 / ISO / HIPAA evidence) — out of scope for v1.

## Existing assets reused

| Asset | Role in security-agent |
|---|---|
| `@agentgate/claude-code-hook` | Gates dangerous shell, edits to security-sensitive paths, HTTP writes, secret-bearing requests |
| `@agentgate/mcp-gate` | Wraps MCP servers (filesystem, github, postgres) so destructive MCP calls are gated |
| `@agentgate/pkg-scan` | Pre-install supply-chain scanner the agent uses during `supply-chain-audit.md` |
| `@agentgate/iac-scan` | Blast-radius scoring for terraform/kubectl during `iac-security-review.md` |
| `@agentgate/control-plane` | Policy engine + audit log + dashboard |

## New components (v1)

### 1. System prompt (`system-prompt.md`)
Loaded as the agent's persona. Enforces the authorization boundary, the read-before-write principle, severity honesty, evidence-citation discipline, and the no-bypass rule.

### 2. Runbooks (`runbooks/*.md`)
One playbook per common security task. The agent pulls the matching runbook into context when the user asks. See `runbooks/README.md` for the full list and selection rubric.

### 3. Rule pack (`rule-pack.json`)
Security-tuned overrides on top of the default rule set. Tightens defaults around IAM, secrets, network, and identity tooling. Loaded by `claude-code-hook` v0.2 when rule-file loading lands.

### 4. Claude Code settings (`claude-settings.json`)
Template for `~/.claude/settings.json`. Installs the `PreToolUse` hook, an opinionated set of MCP servers wrapped through `mcp-gate` (filesystem, github, postgres), and points at the security-agent persona + runbooks.

### 5. Installer (`install.sh`)
One-shot installer mirroring `devops-agent/install.sh`. Confirms agentgate is built, picks a target settings file, generates the populated config, prints next steps.

## Tool surface (interactive mode)

The agent uses whatever tools Claude Code exposes (Bash, Edit, Read, Write, MCP). All of them route through `claude-code-hook` for gating. The runbooks tell the agent which calls are read-only (no gate trigger) versus destructive (announce → approve → execute).

Read-only examples (no gate):
- `git log`, `git diff`, `git blame`, `git show`
- `rg`, `grep`, `cat`, `jq` over local files
- `npm ls`, `pip show`, `cargo tree`, `gradle dependencies`
- `kubectl get/describe/logs` (read-only verbs)
- `aws iam list-* / get-*`, `aws s3 ls`, `aws sts get-caller-identity`
- Reading manifests, terraform plan output, helm template output

Destructive examples (gate triggers):
- Editing files under `.env*`, `secrets/`, `config/production/`, `terraform/*.tf`, k8s manifests, IAM policy JSON
- `git push`, especially `git push --force`
- `kubectl apply / delete / patch / scale`
- `terraform apply / destroy`
- `aws iam create-* / update-* / delete-*`, `aws s3 rm`, `aws kms ...`
- Any `curl -X POST/PUT/DELETE/PATCH` with a bearer token to a control-plane URL
- `npm install`, `pip install` (triggers `pkg-scan` first)

## File map after this spec lands

```
examples/security-agent/
├── README.md                      # interactive-mode docs
├── SPEC.md                        # this file
├── install.sh                     # interactive-mode installer
├── system-prompt.md               # the AppSec persona
├── claude-settings.json           # template for ~/.claude/settings.json
├── rule-pack.json                 # security-tuned overrides
├── runbooks/
│   ├── README.md
│   ├── vuln-triage.md
│   ├── secure-code-review.md
│   ├── secret-leak-response.md
│   ├── security-incident-response.md
│   ├── threat-model.md
│   ├── supply-chain-audit.md
│   ├── iac-security-review.md
│   └── dependency-upgrade.md
└── mcp-bundle/
    └── README.md
```

## v1 acceptance criteria

A demo where:
1. The user runs `./examples/security-agent/install.sh` and starts a fresh Claude Code session in any repo.
2. The user asks: *"Review `src/api/users.ts` for security issues."* — the agent loads `secure-code-review.md`, scans the file, returns findings with file:line citations and severity.
3. The user asks: *"This Dependabot alert just landed for `lodash` — should I patch?"* — the agent loads `vuln-triage.md`, checks reachability, returns a verdict + draft PR.
4. The user asks: *"There's an AWS key in `infra/terraform.tfvars`."* — the agent loads `secret-leak-response.md`, refuses to print the value, drives rotation, scrubs the file, and proposes a `gitleaks` pre-commit hook. The rotation action pauses for human approval in the agentgate dashboard.
5. Every destructive action in the demo lands in the agentgate audit log with a `reason` field that says *why* (the finding) not *what* (the command).

## v2 (out of scope for v1)

- **PR review bot.** GitHub App that comments on PRs with `secure-code-review.md` findings; high-severity gets a `requireApproval` before merge.
- **Scheduled scans.** Cron-triggered supply-chain audit / IaC drift detection against a configured target.
- **Python SDK.** Pythonic surface for Bandit/Semgrep/Trivy integrations.
- **Custom rule pack publishing.** Teams publish their own rule packs (e.g. "Stripe-style" / "HashiCorp-style") for the gate to consume.

## Open questions

1. **Semgrep / CodeQL integration.** Should the agent shell out to these directly, or wrap them as MCP tools? Lean MCP for cache + auth + audit trail.
2. **`gitleaks` / `trufflehog` dependency.** Bundle as a peer dep, or document and let the user install? Lean document.
3. **PR-comment voice.** Once v2 ships, do we comment in-line on the diff, or post one summary comment? Inline is more useful but noisier — needs a `requireApproval` policy on volume.
4. **Authorized-scope enforcement.** v1 enforces this by system prompt + human approval. v2 may want a structured `scope.json` per project that the gate consults before allowing any active probe.
