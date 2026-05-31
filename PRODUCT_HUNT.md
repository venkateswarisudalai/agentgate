# Product Hunt launch kit — agentgate

Everything you need to paste into the PH launch form, plus the demo shot list.

> ⚠️ **Before you launch:** the README/site tell people to `npx @agentgate/...`,
> which fails until you publish to npm. Either run the publish step
> (`npm login` → publish in dep order: sdk, pkg-scan, then mcp-gate, cli,
> claude-code-hook, control-plane) **or** change the CTAs to "clone & run".
> Don't launch on a broken `npx`.
>
> **Timing:** the PH leaderboard resets at 12:01 AM PT. Schedule for 12:01 AM PT
> for the full ranking window rather than launching mid-day.

---

## Name
agentgate

## Tagline (≤60 chars — pick one)
- An AI DevOps engineer you can give prod access to
- A firewall for what your AI agents do in production
- Give your AI agent prod access — safely

## Topics
Developer Tools · Artificial Intelligence · Open Source · DevOps · SaaS

## Links
- Website: <your deployed site>
- GitHub: https://github.com/venkateswarisudalai/agentgate

## Description (the "what is it" field)
agentgate is an AI DevOps engineer that watches your systems, detects faults,
and fixes them — but pauses for human approval before any risky change, with a
rollback plan and a full audit trail for every action.

It's built on a governance layer for AI agents: every tool call your agents make
in production flows through one control plane — policy, approval, kill-switch,
audit — with zero changes to agent code. It works on the MCP standard, so it
governs Claude Desktop, Cursor, Cline, and your own agents, not just one tool.

Open source. Self-host in two commands.

---

## First comment (maker story — post this immediately)

Hi PH 👋 I'm Venka, the maker.

I kept seeing the same thing in 2026: teams hand AI agents real production
credentials — to push code, run infra commands, issue refunds — and then hope a
prompt that says "be careful" holds. It holds about 95% of the time. The other
5% is an incident.

So I built agentgate. It's an AI DevOps engineer that does the work — reads logs,
diagnoses a bad deploy, proposes a rollback — but **freezes before any risky
action and waits for a human**, and writes everything to an audit log. The agent
is the product; the governance is the part you can't safely live without.

It's not a Claude Code plugin or a wrapper — it's a standalone agent, and the
same control plane also gates any agent that speaks MCP (Cursor, Cline, Claude
Desktop) with zero code changes.

It's open source — clone it and have it gating a real agent in about two minutes.
The 90-second demo above shows it catch a bad deploy and roll it back, with me
approving the one risky step.

Would love your brutal feedback — especially from anyone running agents against
prod today. What would you need before you'd trust one with your infrastructure?

---

## 90-second demo — shot list (use the incident-agent flow)

Record one clean take. Terminal + browser. The incident-agent loop IS the pitch.

**Setup:** `npm run demo` running (dashboard at :4000); browser open at
`http://localhost:4000/?tab=agents`; a second terminal ready.
(If you have `ANTHROPIC_API_KEY` set, the diagnosis is real Claude — say so.)

| Time | Screen | Say |
|---|---|---|
| 0:00–0:10 | terminal, blank | "AI agents now run production infrastructure. Telling one 'be careful' fails about 5% of the time. agentgate fixes that. Watch." |
| 0:10–0:20 | run `npm run demo:incident` | "This is an autonomous AI DevOps engineer — its own process, not a chat window. It's watching the orders-api logs." |
| 0:20–0:32 | the deploy + 5xx spike lines | "A bad deploy just landed. The error rate spikes — and the agent catches it on its own." |
| 0:32–0:45 | diagnosis lines | "It diagnoses the cause — that deploy — and proposes a rollback, with a rollback plan. Then it stops. It will not touch prod without me." |
| 0:45–1:05 | browser, Agents/Live tab → Approve | "Here in the dashboard I see exactly what it wants to do and why. I'm the human in the loop. I approve…" |
| 1:05–1:18 | terminal: rollback + recovery | "…and now it rolls back. Error rate's back to baseline. Incident resolved." |
| 1:18–1:30 | audit log | "Every step — detect, diagnose, approve, act — is in the audit log. The agent does the work; you keep control. It's open source, link below." |

**Optional kicker:** end on `node dist/index.js --watch` showing it sitting live,
catching incident after incident — "and it runs autonomously, forever."

---

## Launch-day checklist
- [ ] Publish to npm (or switch CTAs to clone-and-run)
- [ ] Deploy the website to a public URL (GitHub Pages / Vercel)
- [ ] Record the 90s Loom from the shot list above → upload as the PH video/gallery
- [ ] Grab a thumbnail (the interactive terminal on the site)
- [ ] Schedule the PH post for 12:01 AM PT
- [ ] Queue your LinkedIn build-in-public post pointing to the PH page
- [ ] Be online launch morning to answer every comment in the first 2 hours
