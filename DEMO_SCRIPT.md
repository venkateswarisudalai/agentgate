# 90-second Loom script — agentgate demo mode

**Recording target:** ≤ 90 seconds. One take is fine. Loom or QuickTime.

**Setup before you hit record:**
```bash
rm -f packages/control-plane/data/agentgate.db   # clean slate (optional)
npm run demo                                      # builds + starts on :4000
```
Then open Chrome to **http://localhost:4000?tab=demo** in a clean window.
Make the window ~1280×800 so it crops well on LinkedIn.

---

## The script (read it once, then record from memory)

> **[0:00] — opener, on the Demo tab**
>
> "AI agents are now writing code, refunding customers, and running shell commands in production. This is fine, until the day it isn't."
>
> **[0:08] — click "▶ Run all 5"**
>
> "I built agentgate so the day it isn't, it's a pause instead of an incident. Watch."
>
> **[0:15] — switch to the Live tab**
>
> *(Approvals stream in.)*
>
> "Five synthetic agents just tried five risky things. Two were auto-denied by policy — a typosquatted package install, and an agent trying to drop the users table. That second agent is now quarantined."
>
> **[0:30] — point to one of the pending cards (the refund-bot)**
>
> "The other three paused for me. Here's the support bot trying to refund five thousand dollars. Notice — the agent gave a reason, the metadata shows the customer and the amount, and agentgate added a risk story: this can't be undone."
>
> **[0:45] — click Approve on the refund**
>
> "I approve it. The agent unblocks. Every decision — created, policy matched, approved — is in the audit log."
>
> **[0:55] — scroll the audit log briefly**
>
> "That audit log is what makes this work for SOC 2 and incident review later, but the reason engineers install it today is the pause button itself."
>
> **[1:05] — back to the Demo tab, gesture at all 5 scenario cards**
>
> "Three primitives: human-in-the-loop approvals, a policy engine that auto-decides the easy cases, and scoped credentials so agents don't hold long-lived prod keys."
>
> **[1:20] — final**
>
> "Three lines of SDK to wire it into any agent. Open source, self-hostable. agentgate dot dev. Tell me what you'd want it to gate next."

---

## Loom thumbnail / first frame

Make sure the first frame shows the **Demo tab with all 5 scenario cards visible** —
that's the screenshot people see in their LinkedIn feed before they click play.

## LinkedIn caption to pair with the video

> 97% of companies deployed AI agents this year.
> 23% got real ROI.
> The gap is what happens between deploy and disaster.
>
> So I built a pause button.
>
> agentgate sits between an AI agent and the dangerous things it can touch — production databases, money, cloud infra. Risky actions wait for a human. Every decision is logged.
>
> Open source. Self-hostable. Three lines of SDK to wire it into any agent.
>
> 90-second demo below 👇
>
> Tell me what you'd want it to gate next.

## Stills to grab while recording (for follow-up posts)

1. **Frame 1**: Demo tab with all 5 cards
2. **Frame 2**: Live tab with all 5 approvals streaming in (peak visual moment)
3. **Frame 3**: A single pending card showing the risk-story panel (`impact.headline`)
4. **Frame 4**: The audit log scrolled to show `created → policy_matched → approved`

These four stills become four LinkedIn posts. The video is post #5.
