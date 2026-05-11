# Runbooks

Each runbook is a markdown playbook the security agent reads when the user asks for the matching task. Runbooks bake in the **safe sequence**: investigate → diagnose → propose → approve → act → verify.

| Runbook | When to use |
|---|---|
| `vuln-triage.md` | "Is this CVE / Dependabot / Snyk alert exploitable in our code?" — patch decisions |
| `secure-code-review.md` | "Review this file/PR for security issues" — auth, injection, IDOR, crypto misuse |
| `secret-leak-response.md` | "I committed a secret" / "there's a leaked key" — rotation + scrub + prevention |
| `security-incident-response.md` | "We think we've been breached" — suspected compromise, anomalous IAM events, suspicious egress |
| `threat-model.md` | "Threat-model this design / system" — STRIDE-style modeling on new or existing work |
| `supply-chain-audit.md` | "Should I install this package?" / "review our deps" — typosquats, malicious postinstall, lockfile hygiene |
| `iac-security-review.md` | "Review this terraform / k8s manifest / Helm chart" — IAM, encryption, network, public exposure |
| `dependency-upgrade.md` | "Upgrade this vulnerable dependency safely" — patch matrix, breaking changes, rollback |

## Conventions

- **Step 1 is always read-only.** No tool call in step 1 should be capable of mutating state.
- **Destructive steps explicitly call out the agentgate approval.** The runbook reminds the agent: "this will pop up in the dashboard for human approval — narrate what you're doing first."
- **Findings always have evidence.** Every finding needs a file:line, a payload, or a log excerpt. No vibe findings.
- **Severity is honest.** Rate on exploitability + blast radius, not CVSS bookkeeping.
- **Each runbook ends with `Verify` and `Document`.** The job isn't done until you've confirmed the fix held and updated the ticket / postmortem / advisory.

## Adding a new runbook

Copy the structure of `vuln-triage.md`. Keep it under one screen if possible — readers are triaging under pressure. Use bullet lists, not paragraphs. Lead each section with a verb.
