# 90-second launch demo — shot list + narration

The clip that *is* the launch post. One take, no slides. Goal: a stranger watches a
real dangerous agent call get frozen, and immediately gets it.

**Setup before recording**
- Terminal A: `npm run demo` running (control plane on :4000).
- Browser: dashboard open at `http://localhost:4000/?tab=agents`, zoomed so cards are legible.
- Terminal B: cleared, ready to run `npm run demo:mcp`.
- Hide bookmarks bar, notifications off, 1280×720 minimum.

---

### Shot 1 — The hook (0:00–0:12)
**Screen:** terminal B, blank.
**Say:**
> "AI agents in production can now delete your database, refund a customer, or drop a table — and a prompt that says 'don't' fails about 5% of the time. agentgate puts a firewall in front of those actions. Watch."

### Shot 2 — Run it (0:12–0:25)
**Do:** type `npm run demo:mcp`, hit enter.
**Say:**
> "This is an unmodified MCP client — same one you'd use with Claude or Cursor — talking to a server through agentgate. No agent code changed. It makes two tool calls."

### Shot 3 — The safe call passes (0:25–0:38)
**Screen:** the `list_users() ✓ passed through in 0ms` line.
**Say:**
> "First call is read-only — list users. agentgate classifies it as safe and waves it straight through. Zero friction, zero latency. Reads don't get in your way."

### Shot 4 — The dangerous call freezes (0:38–0:52)
**Screen:** the `drop_table(...) ⏸ FROZEN` line.
**Say:**
> "Second call: drop a table. Destructive. agentgate freezes it mid-flight — the call never reaches the server — and waits for a human."

### Shot 5 — The dashboard (0:52–1:10)
**Do:** switch to browser, Agents tab → click the pending agent → Live tab.
**Say:**
> "Over in the dashboard, here's the agent, here's exactly what it tried to do, the risk, the arguments. I'm the human in the loop. I can approve…"
**Do:** click **Approve**.
**Screen:** cut back to terminal — `✓ approved — call forwarded`.
**Say:**
> "…and now, and only now, it runs."

### Shot 6 — The close (1:10–1:30)
**Screen:** the audit log on the Live tab.
**Say:**
> "Both calls — from the same agent — and every decision is in the audit log. Policy, approval, kill-switch, audit. Zero agent code; it works on the MCP standard. It's open source — link below. Go gate your agents before they gate you."

---

## Posting copy (LinkedIn / Show HN)

**Show HN title:**
`Show HN: agentgate – a firewall for what your AI agents do in production (MCP)`

**LinkedIn opener (no superlatives, factual):**
> AI agents now hold prod credentials — they push code, issue refunds, run infra commands. I built agentgate: it sits in front of an agent's tool calls, freezes the destructive ones for human approval, and audits everything. Zero changes to the agent — it wraps any MCP server. 90-second demo:

**First comment / body:** link to repo + the README "wrap your own server in 5 minutes" section.
