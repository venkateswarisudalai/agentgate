# Runbook: Scale Out

**When to use:** load-shed, latency rising, queue depth growing, CPU/memory at limits.

## 1. Confirm scaling is the right answer (read-only)

Before scaling, verify the bottleneck is actually capacity:
- Are there errors in logs? (if yes — scaling won't help; investigate the error)
- Is one specific dependency slow? (if yes — scale that, not the caller)
- Is there a traffic spike, or has steady-state demand grown? (changes whether this is incident or capacity work)
- Is HPA already running and not keeping up?

## 2. Pick the smallest viable scale-up

- Today's pod count → target count. Be specific.
- Avoid "double it" — pick a number based on observed CPU/memory headroom.
- If you'd be more than 2x'ing, also escalate to a human — that suggests a load-shape change worth understanding.

## 3. Announce

> "Scaling `<deployment>` in `<namespace>` from `<N>` to `<M>` replicas. Reason: `<observed metric>`. Expected effect: `<latency / capacity>`. Cost impact: `<rough $>`. Approval needed."

## 4. Execute (gated)

- `kubectl scale deployment <name> --replicas=<M>` — gated
- Or update HPA min/max if the deployment is HPA-managed
- Or update the cluster autoscaler if you're node-bound (different conversation, escalate)

## 5. Verify

- New pod count is running and Ready
- Latency / queue depth returning to normal
- Cost monitor not alarming

## 6. Document

- If this was incident-driven, link in the incident ticket
- If this changed steady-state, file a capacity-planning follow-up so the new size is documented in IaC

## Anti-patterns

- ❌ Scaling without first checking logs for errors
- ❌ "Scaling to be safe" — costs real money, often masks the real problem
- ❌ Scaling more than 2x without thinking about the underlying load shape
