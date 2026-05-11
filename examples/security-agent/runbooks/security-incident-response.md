# Runbook: Security Incident Response

**When to use:** suspected compromise. Anomalous IAM events, suspicious egress, unexpected processes, unknown admin users, ransomware indicators, customer report of account takeover.

> If you are not certain this is a security incident, it is still a security incident. Treat as one until disproven.

## 0. Roles and comms

- **Incident commander (IC)** — owns decisions. Usually security on-call. Not the agent.
- **Investigator(s)** — the agent + the on-call engineer.
- **Comms** — separate channel (`#sec-incident-YYYY-MM-DD`); do not discuss in normal eng channels.
- **Out-of-band channel** if you suspect chat / email is compromised: phone, in-person, signal.

The agent's job is investigator. The IC role stays with a human.

## 1. Detect and confirm (read-only — silent)

Capture the trigger:
- **Source** — alert, customer report, vendor notification, third-party threat intel, dump-site post
- **First-seen timestamp** — and your evidence for it
- **Affected identity / system / data** — best guess; refine as you learn

Quick read-only checks:
- `aws cloudtrail lookup-events` for the suspect identity, last 24–72h
- `kubectl get events --all-namespaces --sort-by=.lastTimestamp` for the affected cluster
- App logs for the affected service window
- VCS audit log (`gh api /orgs/:org/audit-log`) if the suspect is a developer identity
- DB query log for the suspect connection

## 2. Contain — stop the bleeding (gated — human approval required for every action)

Contain *before* you fully investigate. You can always investigate a contained incident; you can't un-exfil data.

Containment menu (each is a separate approval):
- **Disable / suspend the suspect identity** — IAM user, GitHub member, SSO account
- **Revoke all active tokens for the identity** — AWS `aws iam delete-access-key` for all keys; GitHub revoke all PATs; OAuth refresh-token revocation
- **Rotate credentials the identity could have touched** — see `secret-leak-response.md`
- **Apply a deny-all firewall / WAF rule** for the suspect source IP / ASN
- **Quarantine the affected host / pod / container** — cordon + drain in k8s; isolate in VPC
- **Take a forensic snapshot** before terminating — EBS snapshot, container filesystem tar, memory dump if relevant
- **Disable the affected feature / endpoint** — feature flag, edge rule

Narrate each:
> "Going to suspend IAM user `<user>` and revoke its 2 active access keys. Reason: CloudTrail shows `s3:GetObject` from this identity against 47 customer-data buckets from an unfamiliar IP in the last 30 minutes, against historical baseline of zero. Blast radius: any process using this user's keys will start failing immediately — we believe only `legacy-batch-job` uses it, and that job is paused. Rollback: re-enable user and re-create keys (~2 minutes)."

**Containment policy:** when in doubt, contain. The cost of an unnecessary disable is minutes of downtime. The cost of a missed compromise is much higher.

## 3. Investigate (read-only — silent, after containment)

Build a timeline:
- **What identity / system** — primary and any secondary identities the attacker pivoted through
- **What did they touch?** — list every API call, query, file, deploy, push, admin action
- **What did they take?** — was data exfiltrated? S3 GetObject volumes, egress bytes, query result sizes
- **What did they change?** — any IAM additions, MFA disables, recovery email/phone changes, webhook additions, repo settings, deploy hooks
- **How did they get in?** — credential leak, phishing, vulnerable service, insider, supply chain
- **Are they still in?** — any persistence mechanisms? new IAM users, cron jobs, scheduled lambdas, deploy keys, OAuth app installs, k8s admission webhooks

Useful read-only one-liners (adapt to your env):
- `aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=<user>`
- `aws iam list-access-keys --user-name <user>`
- `gh api /repos/:owner/:repo/actions/secrets` — has the attacker added a CI secret?
- `kubectl get serviceaccounts,roles,rolebindings,clusterrolebindings -A | rg <suspect-pattern>`
- `git log --all --since="<incident-start>" --pretty=format:'%h %an %ae %s'` — any commits from the suspect identity?

## 4. Eradicate (gated — human approval required)

For each persistence mechanism found in step 3:
- Remove it — narrate, approve, execute
- Verify it's gone with a second read-only check
- Note the time + actor in the timeline

Common eradications:
- Delete attacker-created IAM users / keys / roles / policies
- Remove attacker-added OAuth app installs (GitHub, Slack, Google)
- Remove attacker-added webhooks, deploy hooks, scheduled actions
- Revert attacker commits / undo attacker deploys
- Drop attacker-created DB users; rotate any DB credentials they may have read

## 5. Recover (gated)

Once eradication is complete and verified:
- **Restore service** — un-quarantine hosts, lift feature flags, restore endpoints
- **Re-enable identities** that were precautionarily disabled but are confirmed clean
- **Watch tightly** — error rates, auth volumes, egress, anything that would indicate the attacker is back

## 6. Notify

- **Internal** — eng leadership, exec, legal, comms — per your org's escalation tree
- **Customers** — if their data was reachable, your obligation is set by privacy law (GDPR 72h, CCPA, state breach-notification statutes) and your contracts (SOC 2, BAA, MSAs)
- **Regulators** — per applicable law (varies by industry and jurisdiction)
- **Vendors** — your auth provider, your cloud, any vendor whose system was implicated

The agent drafts; legal + IC approve before sending. Do not send external comms without an explicit human approval.

## 7. Document (postmortem)

Within 1 week of recovery:
- **Timeline** — every action, who, when, evidence
- **Root cause** — how they got in, what control failed
- **Impact** — what they took, what they changed, who's affected
- **Action items** — preventive (control improvements), detective (alerts you wish you had), responsive (runbook gaps)
- **Audit log link** — agentgate already has every action; link it

Access-control the postmortem. Not everyone needs the IP addresses and the customer list.

## Anti-patterns to avoid

- Investigating before containing
- Containing a single identity when the attacker has clearly pivoted to a second
- Restoring service before eradication is verified ("they're gone, right?" — prove it)
- Closing the incident before action items are filed
- Discussing the incident in channels the attacker might still read
- Using the affected admin identity to investigate the incident
