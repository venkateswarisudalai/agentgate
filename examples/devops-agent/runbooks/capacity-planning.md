# Runbook: Capacity Planning (read-only investigation)

**When to use:** "Are we sized right for next quarter?", "What's our headroom?", "Will Black Friday break us?"

This is a **read-only** runbook. The agent should never need to gate anything here. Output is a report.

## 1. Define the question precisely

- Time horizon (next month? next quarter? next big event?)
- Which services / systems
- Acceptable buffer (target % headroom on the bottleneck resource)
- Constraint: cost ceiling, regional capacity, license seats, etc.

## 2. Pull current usage

For each service:
- p50, p95, p99 of CPU, memory, request rate, queue depth
- Saturation events in the last 30 days (when did we hit a limit?)
- Auto-scaling behavior (how often did HPA scale, max replicas hit, throttle events)

## 3. Pull projected demand

- Application-level: requested by the team that owns the system. (e.g. "marketing forecasts 3x traffic in Nov")
- Trend: linear extrapolation from the last 90 days, with confidence band
- Seasonal: do prior years show seasonal spikes? Same week of prior year + recent growth

## 4. Identify bottlenecks

For each service:
- Resource limit hit first (CPU? memory? DB connections? rate limit on a downstream API?)
- Single points of failure (the one read-replica, the one cache shard, the one queue worker)

## 5. Make recommendations

For each bottleneck:
- Current → projected demand
- Headroom remaining at projected demand
- Recommended change (add capacity, change instance type, shard the bottleneck, add cache)
- Cost delta
- Implementation effort (this week / next sprint / next quarter)

## 6. Output a report

Markdown report with: question, headline finding (e.g. "we have 4 weeks of headroom"), per-service table, prioritized recommendations.

The user reads this and decides what to actually do — that's a separate ticket, with separate approvals.

## What to NOT do

- ❌ Don't scale anything as part of this runbook. This is investigation.
- ❌ Don't open infra change PRs. Output a report; let the human decide.
- ❌ Don't recommend the largest possible buffer "to be safe" — the real answer is data-driven.
