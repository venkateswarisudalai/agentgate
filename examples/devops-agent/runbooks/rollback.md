# Runbook: Rollback

**When to use:** the last deploy made things worse. Roll back is almost always preferable to "fix forward in prod".

## 1. Identify the bad change (read-only)

- What's the current image tag / commit / helm revision in the affected env?
- What's the previous known-good revision?
- Was there a database migration in the bad deploy? (this changes the rollback strategy)

## 2. Choose the rollback strategy

| Situation | Strategy |
|---|---|
| Code-only change | Roll back the deployment to previous revision |
| Code + backward-compatible migration | Roll back code; leave migration in place |
| Code + non-backward-compatible migration | **Stop. Escalate.** Rolling back code now will break against the new schema. Need a forward-fix or migration reversal. |
| Terraform-only change | `git revert` the TF, `terraform plan`, then apply (gated) |
| Config-only change | Restore previous config, restart |

## 3. Announce

> "Rolling back `<service>` in `<env>` from `<bad-revision>` to `<good-revision>`. Reason: `<symptom>`. Migration considerations: `<safe|unsafe>`. Approval needed for: rollout undo / helm rollback / terraform apply."

## 4. Execute (gated)

For Kubernetes:
- `kubectl rollout undo deployment/<name>` — gated by agentgate (`kubectl-destructive` rule)

For Helm:
- `helm rollback <release> <revision>` — gated

For Argo Rollouts:
- `argo rollouts undo <name>` — gated (less destructive; may be auto-approvable in week 2 policy engine)

## 5. Verify

- Symptom from the original incident is resolved
- No new alerts firing
- The rolled-back version is the one actually running (`kubectl describe`, `helm history`)

## 6. Document

- Update the incident ticket with rollback time and revision
- File a follow-up ticket for the actual fix — don't leave the rolled-back state as "the new normal"
