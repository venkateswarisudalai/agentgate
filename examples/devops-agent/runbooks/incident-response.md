# Runbook: Incident Response

**When to use:** alerts firing, customer reports, error spikes, latency anomalies.

## 1. Triage (read-only — silent)

- What is the symptom in one sentence? (e.g. "5xx rate on /api/orders went from 0.1% to 12% at 18:42 UTC")
- What's the customer impact? (e.g. "checkout flow broken, ~30% of sessions affected")
- Is this paging? (escalate if no)
- Time-bound the investigation: aim for diagnosis in < 15 min, mitigation < 30 min.

## 2. Investigate (read-only — silent)

In rough order:

- **Recent changes.** `git log --since="2 hours ago"`, recent deploys, recent feature flag flips, recent infra changes.
- **Metrics.** Error rate, latency p95/p99, request volume, saturation, dependency health. Compare to a known-good window.
- **Logs.** Tail the affected service. Look for stack traces, panics, repeated errors, timeouts.
- **Dependencies.** Is the database up? Cache? Auth? External APIs?
- **Resource state.** `kubectl get pods`, node CPU/memory, db connections, queue depth.

## 3. Form a hypothesis

State it explicitly:
> "I think this is X because A, B, and C. The disconfirming evidence I'd expect to see is D. Let me check D."

If you can't form a hypothesis after 10 minutes of investigation, **escalate to a human**.

## 4. Choose a remediation (with the user)

In order of preference (least to most blast-radius):
1. **Restart the affected pod** (one pod, not the deployment)
2. **Scale up** (more capacity for load-related issues)
3. **Roll back the last deploy** (if changes correlate with start time)
4. **Toggle a feature flag** (if the change is flag-gated)
5. **Apply a config patch** (env var, secret, resource limit)
6. **Apply a code hotfix** (PR, deploy, verify)

For each option, state:
- WHAT (literal command)
- WHY (links to the diagnosis above)
- BLAST RADIUS (who/what is affected)
- DRY-RUN (have you checked the diff?)
- ROLLBACK (how to undo if this makes things worse)

## 5. Execute (gated — human approval required for each step)

- Run ONE remediation at a time.
- Each destructive call goes through agentgate. Narrate first, then call.
- Watch the relevant metric for 2–5 minutes after each step.
- If symptoms don't improve, do NOT pile on more changes. Re-diagnose.

## 6. Verify

- Has the symptom returned to normal? (specific metric, specific threshold)
- Are there secondary effects? (downstream services, error budgets, dependent jobs)
- Is the customer impact resolved?

## 7. Document

- Post a status update in #incidents or wherever your team coordinates.
- File a postmortem ticket. Include: symptom, root cause, remediation, action items.
- The agentgate audit log already has every action — link to it from the postmortem.

## Anti-patterns to avoid

- ❌ Silencing the alert to "buy time" — fix the underlying issue or escalate
- ❌ Restarting more than 3 things in a row without re-diagnosing
- ❌ Applying multiple changes at once and not knowing which one worked
- ❌ Skipping the verify step ("looks fine, moving on")
- ❌ Acting on a guess in production without a falsifiable hypothesis
