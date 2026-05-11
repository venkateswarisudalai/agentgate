# Runbook: Secret-Leak Response

**When to use:** a credential, API key, private key, or token has been committed, logged, posted, or otherwise exposed. Treat as a live incident until proven otherwise.

## 0. Handling rules (read this first)

- **Never paste the secret value into chat, logs, comments, commits, or PR descriptions.** Refer by file:line.
- **Assume the secret is compromised** the moment it leaves the intended boundary. Rotate before you investigate, not after.
- **Rotation is owned by the team that owns the credential.** You drive the timeline, but you don't rotate keys you don't own — you page the owner.

## 1. Identify and classify (read-only — silent)

- **What kind of secret?** AWS key, GCP service account JSON, GitHub PAT, Stripe key (live vs test), Slack token, OAuth client secret, database password, signing key, private TLS cert, JWT signing secret, npm token, SSH key
- **Where?** file:line, commit hash, branch(es), PR(s), log file, Slack channel, Notion page
- **How long has it been exposed?** `git log -p -S '<truncated-prefix>' --all` — find the first commit that introduced it; same for last edit
- **Who could have accessed it?** Public repo / internal repo / private repo / chat / log shipper / CI artifact. Each implies a different blast radius.
- **What does it permit?** Read-only? Read-write? Admin? Customer-data access? Money-moving?

## 2. Decide rotation urgency

| Exposure | Rotate within |
|---|---|
| Public repo, push happened, key permits writes to prod | **Now** (minutes) |
| Public repo, push happened, read-only key | Today |
| Internal repo, never pushed (caught in local branch) | Today, but no panic |
| Logged in a CI artifact retained < 24h | Today |
| Chat / shared doc | Same day; depends on audience |

If you're not sure of exposure, **assume worst case**.

## 3. Rotate (gated — human approval required)

Drive rotation through the owning team. The agent does not rotate keys directly unless the user is the owner.

For each credential type, the rotation path:

- **AWS access key** — owner runs `aws iam create-access-key` for a new pair, swaps in the consumer, then `aws iam delete-access-key` on the old one. Gate prompts for the delete.
- **GitHub PAT** — owner creates a new token, updates the consumer (CI secret, env), revokes the old one in GitHub settings.
- **Stripe key** — `Roll key` in the Stripe dashboard. Live keys are aggressive — coordinate with billing.
- **OAuth client secret** — generate new in the provider console, update relying parties, revoke old.
- **DB password** — coordinate with DBA. Often a rolling change requires a brief dual-credential window.
- **Signing keys (JWT / cookies)** — sign new tokens with the new key; honor old key for a grace window; cut over.
- **Private TLS cert / SSH host key** — re-issue, update consumers, revoke old (CRL / authorized_keys).

Narrate before each gated rotation:
> "I'm coordinating rotation of the AWS access key referenced at `infra/terraform.tfvars:12` (value redacted, identified by IAM user `<user>`). Owner: platform team. New key already provisioned in the consumer. Approving will delete the old key. Blast radius: any service still using the old key will start 403'ing within seconds — owner has confirmed cutover is complete. Rollback: re-create the key from the IAM history within ~5 minutes."

## 4. Scrub the artifact (gated)

Once rotation is complete (or in parallel, if the secret is also being actively abused):

- **Code repo** — replace the value with a reference to a secret manager (`process.env.X` / Vault / AWS Secrets Manager / GCP Secret Manager). Commit.
- **Git history** — if the secret is in history of a **public** repo, history rewrite (`git filter-repo` or BFG) is required. This is destructive; gate prompts. Coordinate with everyone who has a clone — they'll need to re-clone.
- **Logs** — purge the offending log lines from log storage. Add a redaction rule to the log shipper so it doesn't recur.
- **Chat / docs** — delete the message / edit the doc. Note that Slack retention may keep an audit copy; ask Slack admin if compliance applies.

Don't push history-rewrite without explicit user OK — it breaks every collaborator's clone.

## 5. Audit for downstream impact (read-only — silent)

Was the secret *used* by an attacker before rotation? Check:
- **CloudTrail / audit log** for the rotated identity: any calls from unfamiliar IPs, user-agents, regions, or unusual API combinations
- **Application logs** for usage of the old credential value after the leak window
- **GitHub security log** (`gh api /repos/:owner/:repo/audit-log`) for PAT use
- **Stripe events** for unauthorized charges / refunds
- **Database** for anomalous queries, exports, schema changes

If you find abuse, switch to `security-incident-response.md`.

## 6. Prevent recurrence

Don't just fix the leak — fix the *class*. Propose one or more:
- **Pre-commit hook** — `gitleaks` / `trufflehog` / a custom regex set; install via `pre-commit` framework
- **Server-side scan** — GitHub secret scanning push protection (free for public repos, paid for private)
- **Secret manager** — move the value into Vault / AWS SM / GCP SM; reference by ARN, never inline
- **Log redaction** — a pattern set in the log shipper that drops common secret formats
- **Code review checklist** — add "no inline credentials" as a review gate (and make the linter enforce what it can)

Open follow-up tickets for each. Don't close the incident until at least one preventive control is in place.

## 7. Document

- Postmortem (private, access-restricted): credential type, blast radius, exposure window, rotation timeline, scrub steps, abuse evidence (or lack of), preventive controls added
- Notify any obligated parties: customers if their data was reachable; auth provider if a federated credential was involved; legal if regulated data was reachable
- The agentgate audit log already has the rotation + scrub actions — link it from the postmortem

## Anti-patterns to avoid

- "It was only in a private repo, no need to rotate" — rotate anyway. Private isn't a security control.
- Rotating without revoking the old credential
- History-rewriting without telling collaborators
- Scrubbing the file without rotating the key
- Closing the incident before the preventive control is in place
- Pasting the leaked value anywhere — chat, ticket, postmortem — to "show what was leaked"
