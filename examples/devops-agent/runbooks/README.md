# Runbooks

Each runbook is a markdown playbook the DevOps agent reads when the user asks for the matching task. Runbooks bake in the **safe sequence**: investigate → diagnose → propose → approve → act → verify.

| Runbook | When to use |
|---|---|
| `incident-response.md` | "Something is broken in prod" — alerts firing, errors spiking, latency up |
| `deploy.md` | "Deploy this change to {env}" |
| `rollback.md` | "Roll back the last deploy" / "Revert to previous version" |
| `scale-out.md` | "We're getting load-shed" / "Scale up the {service}" |
| `model-promotion.md` | "Promote model {name} v{N} to {stage}" |
| `capacity-planning.md` | "Are we sized right for next quarter?" / read-only investigation |

## Conventions

- **Step 1 is always read-only.** No tool call in step 1 should be capable of mutating state.
- **Destructive steps explicitly call out the agentgate approval.** The runbook reminds the agent: "this will pop up in the dashboard for human approval — narrate what you're doing first."
- **Each runbook ends with `Verify` and `Document`.** The job isn't done until you've confirmed the change worked and updated the incident channel / ticket / postmortem.

## Adding a new runbook

Copy the structure of `incident-response.md`. Keep it under one screen if possible — operators read these under stress. Use bullet lists, not paragraphs.
