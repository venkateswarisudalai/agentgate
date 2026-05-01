# Runbook: Deploy

**When to use:** "Deploy this change to {staging|prod}", "Ship the latest main".

## 1. Pre-flight (read-only — silent)

- What's being deployed? (`git log <prev>..HEAD` of the deployable branch)
- Does CI pass on this commit?
- Is the target environment healthy right now? (no active incidents, no pending alerts)
- Is there a deploy freeze or maintenance window?
- For prod: has this gone through staging successfully?

## 2. Plan

- For Kubernetes: which Deployments/StatefulSets/DaemonSets get new images?
- For Terraform: `terraform plan` and read the diff out loud. Pay attention to anything marked `- destroy` or `~ replace`.
- For database migrations: are they backward-compatible? Will old code still work against the new schema?

## 3. Announce

State explicitly:
> "Deploying commit `<sha>` to `<env>`. Affected services: X, Y. Expected blast radius: <impact>. Rollback: `<command>`. Approval needed for: deploy script, terraform apply, migration."

## 4. Execute (gated)

In sequence:
1. **Migration** (if any) — backward-compatible only. Approval required.
2. **Image push** — usually safe; passes silently unless your registry is publish-gated.
3. **Rollout** — `kubectl rollout` / helm upgrade / your deploy script. Approval required.
4. Watch the rollout: `kubectl rollout status` until ready or until first new pod is healthy.

## 5. Verify

- Health check passes
- Error rate stable (no spike from baseline)
- Latency stable
- A canary metric specific to the change (if one exists)
- Smoke-test the changed surface (a known-good request)

If verification fails: **roll back immediately** (see `rollback.md`). Don't try to "fix forward" in prod.

## 6. Document

- Post in #deploys: commit SHA, what changed, deploy time, who approved.
- The audit log captures the gated steps automatically.
