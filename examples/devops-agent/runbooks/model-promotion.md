# Runbook: ML Model Promotion

**When to use:** "Promote model `<name>` v`<N>` from `<staging>` to `<prod>`".

## 1. Verify offline metrics (read-only)

- Has v`<N>` been evaluated against the standard offline test set?
- How does it compare to the current Production model on every key metric?
- Are there any segments where it regresses, even if global metric improves?
- Is there a model card / eval report?

## 2. Verify the shadow / canary phase

A model should never go straight to Production. Verify:
- It's been running in shadow (mirrored traffic, no impact) for at least N days
- Or it's been at canary (small % of live traffic) and online metrics match offline
- No rollback events during shadow/canary

## 3. Verify dependencies

- Feature freshness: are all features used by v`<N>` available in the online feature store?
- Schema: does the online endpoint accept the v`<N>` input schema?
- Latency: is v`<N>` within SLA at production load?
- Cost: any new features being computed online change inference cost?

## 4. Announce

> "Promoting model `<name>` v`<N>` from `<current_stage>` to `Production`. Replacing v`<M>` (`registered <date>`). Offline lift: `<X%>`. Shadow window: `<duration>`. Rollback: re-promote v`<M>` via the same workflow. Approval needed."

## 5. Execute (gated)

- `mlflow models transition-stage -m <name> -v <N> --stage Production` — gated by `mlflow-prod-stage` rule
- Or: `aws sagemaker update-endpoint ...` — gated by `sagemaker-endpoint` rule
- Or: `gcloud ai endpoints deploy-model ...` — gated by `vertex-ai-deploy` rule

## 6. Verify

- Online metrics for the next 30 minutes (latency, error rate, prediction distribution)
- Specific quality metric for the next 24 hours (depends on use case — CTR, conversion, MSE, etc.)
- Drift monitors not firing
- No customer-impact tickets

## 7. Document

- Update the model registry's description with the promotion timestamp + approval
- Notify the consuming team / channel
- The agentgate audit log captures who approved the promotion — link to it in the model card
