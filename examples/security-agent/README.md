# Security Agent on agentgate

A pre-configured Claude Code experience that turns the editor into a **world-class application security engineer**. Every dangerous action routes through the agentgate control plane. Every action lands in the audit log. The persona refuses to act on systems the user doesn't own or have authorization to test.

You don't install a new agent. You install a **persona + opinionated config + runbooks** for Claude Code, with the agentgate hook and MCP gate already wired in.

## What you get

- A **system prompt** (`system-prompt.md`) that makes Claude Code behave like a defensive senior AppSec engineer: investigates before changing, cites evidence, scores severity honestly, refuses unauthorized scope, never bypasses approvals.
- A **`.claude/settings.json` template** that installs the agentgate `PreToolUse` hook and a starter MCP bundle (filesystem, github, postgres) wrapped through `mcp-gate`.
- A set of **runbooks** (`runbooks/`) Claude Code reads as project context: vuln triage, secure code review, secret-leak response, security incident response, threat modeling, supply-chain audit, IaC security review, dependency upgrade. Each one bakes in the safe sequence (read first → diagnose → cite evidence → propose → approve → act → verify).
- A **rule pack** (`rule-pack.json`) of opinionated overrides for security work: redact secret patterns, deny offensive tools by default, ask-by-default on every IAM / network / secret / supply-chain action (loaded once `claude-code-hook` supports config files in v0.2).

## 10-minute install

```bash
# 1. Make sure the agentgate control plane is running
node packages/control-plane/dist/index.js &

# 2. Install the Security Agent persona for your Claude Code
./examples/security-agent/install.sh

# 3. Open http://localhost:4000 (dashboard) or run `agentgate watch` in a terminal
# 4. Start a fresh Claude Code session in any repo
```

The next time you ask Claude Code to do something security-y ("review this PR for security issues", "this Dependabot alert just landed — should I patch?", "there's a leaked key in `infra/terraform.tfvars`"), it'll:
- Pull the relevant runbook into context
- Do read-only investigation silently
- Pause for your approval before any destructive write
- Log every action to agentgate's audit trail

## Try it

Open Claude Code and try:

> "Review `src/api/orders.ts` for security issues. Focus on authn, IDOR, and injection."

The agent will follow the `secure-code-review.md` runbook: list entry points (silent), trace data flows (silent), surface findings with file:line evidence and an impact-likelihood-confidence score, propose a remediation diff, **wait for your approval** before editing the file.

Or try:

> "There's a GitHub Dependabot alert for `axios` SSRF in our repo — is it exploitable here?"

The agent will follow the `vuln-triage.md` runbook: locate `axios` in the lockfile (silent), trace all import sites (silent), check whether the SSRF gadget is reachable from any HTTP handler (silent), return a verdict — patch now / patch later / not exploitable here.

## What this demonstrates

This is the **end-to-end product story** of agentgate for security work, in one runnable example:

- Cross-tool gating — Claude Code hook + MCP gate both in play
- Read-only investigation doesn't get in the user's way
- Destructive operations always get a human in the loop
- Audit log captures who did what, why, and when — useful both for the next engineer and for any compliance auditor that asks
- A real AppSec persona that knows how to do security work safely and refuses to do it unsafely

It's not a new agent — it's **a recipe for using existing agents safely in security work.**

## File map

```
examples/security-agent/
├── README.md                          # this file
├── SPEC.md                            # design spec
├── install.sh                         # one-shot installer
├── system-prompt.md                   # the AppSec persona
├── claude-settings.json               # template for ~/.claude/settings.json
├── rule-pack.json                     # opinionated rule overrides (v0.2)
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
    └── README.md                      # which MCP servers, why, install commands
```

## What this is NOT

- Not a new agent runtime (Claude Code is the runtime)
- Not a fork of Claude Code
- Not a SOC / SIEM / EDR replacement — this is a workbench for an engineer, not a detection pipeline
- Not a competing product to Snyk / Semgrep / GitHub Advanced Security — it complements them; you'd use those tools' findings as inputs to the agent's triage runbook
- Not a model — no fine-tuning, no training data
- Not a tool for testing systems you don't own — see `system-prompt.md` §"Authorization boundary"
- Not production-ready (see top-level README — agentgate itself is `v0.0.1-alpha`)

## Related

- `examples/devops-agent/` — the same shape, for SRE work
- `packages/pkg-scan/` — supply-chain scanner used by `supply-chain-audit.md`
- `packages/iac-scan/` — blast-radius scoring used by `iac-security-review.md`
- `packages/claude-code-hook/` — the gate; rule pack here plugs in once v0.2 lands rule-file loading
