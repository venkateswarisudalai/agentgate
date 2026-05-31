# incident-agent — an AI DevOps engineer, gated by agentgate

The loop a real SRE runs, automated and made safe:

```
WATCH logs → DETECT a fault → DIAGNOSE root cause → PROPOSE a fix
           → ASK a human (agentgate) → ACT → audit
```

This is the end-to-end product story: an agent that **does** ops work, where every
risky step is gated by a human and recorded — the thing you can actually give
production access to.

## Run it

```bash
npm run demo            # terminal 1: agentgate control plane + dashboard on :4000
npm run demo:incident   # terminal 2: the AI DevOps engineer
```

Watch the terminal: `orders-api` is healthy, a `v43` deploy lands, the 5xx rate
spikes. The agent detects the anomaly, correlates it with the deploy, and proposes
a rollback — then **stops and waits**. Approve or deny at
[http://localhost:4000/?tab=agents](http://localhost:4000/?tab=agents). On approval
it rolls back and verifies recovery from the logs; on denial it stands down and
leaves the incident open. Either way, the decision is in the audit log.

## What's real vs. simulated

- **Real:** the detect → diagnose → propose → **gate through agentgate** → act loop,
  the approval round-trip, and the audit trail. This is the actual control flow a
  production version runs.
- **Simulated (for a self-contained demo):** the `orders-api` log stream and the
  rollback. Swap `OrdersApi` for a real log/metric source (Loki, Datadog, CloudWatch)
  and the rollback for a real `kubectl rollout undo` / deploy API call.
- **The seam for "more AI":** `diagnose()` is deterministic so the demo always works.
  Replace it with an LLM (Claude) call over the log buffer + deploy history to make
  the reasoning genuinely open-ended. The interface it returns stays the same.

## Why it matters

Devin, Mendral and others can do ops work — but you can't safely give them prod.
This agent is **safe by construction**: it investigates freely (read-only), but every
state-changing action pauses for a human and lands in an immutable audit log. That
governance is the moat, not a bolt-on.
