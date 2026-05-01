#!/usr/bin/env node
import { Api, ApiError, streamEvents, type Approval } from "./api.js";
import { renderApprovalCard, renderTable } from "./render.js";
import { c } from "./colors.js";
import { hostname, userInfo } from "node:os";
import * as readline from "node:readline";

const BASE_URL = process.env.AGENTGATE_URL ?? "http://localhost:4000";
const ME = process.env.AGENTGATE_USER ?? `${userInfo().username}@${hostname().split(".")[0]}`;
const api = new Api(BASE_URL);

function usage(exit = 0) {
  const out = `${c.bold("agentgate")} — terminal CLI for the agentgate control plane

Usage:
  agentgate watch [--include-low]            live tail; press y/n inline to approve/deny
  agentgate list  [--status pending|all]     list approvals
  agentgate show  <id>                       full details for one approval
  agentgate approve <id> [--reason "..."]    approve an approval
  agentgate deny    <id> [--reason "..."]    deny an approval
  agentgate audit [--limit N]                show recent audit events
  agentgate health                           ping the control plane

Env:
  AGENTGATE_URL    base URL of the control plane (default ${BASE_URL})
  AGENTGATE_USER   identity recorded as 'decidedBy' (default ${ME})
  NO_COLOR=1       disable ANSI colors
`;
  process.stdout.write(out);
  process.exit(exit);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function resolveId(idOrPrefix: string): Promise<string> {
  if (idOrPrefix.length === 36 && /^[0-9a-f-]+$/i.test(idOrPrefix)) return idOrPrefix;
  // Short prefix — look it up across pending + recent approvals.
  const candidates = [...(await api.list("pending", 200)), ...(await api.list(undefined, 200))];
  const seen = new Set<string>();
  const matches: { id: string; status: string }[] = [];
  for (const a of candidates) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (a.id.startsWith(idOrPrefix)) matches.push({ id: a.id, status: a.status });
  }
  if (matches.length === 0) {
    process.stderr.write(c.red(`no approval matches prefix '${idOrPrefix}'\n`));
    process.exit(1);
  }
  if (matches.length > 1) {
    process.stderr.write(c.red(`ambiguous prefix '${idOrPrefix}' — matches:\n`));
    for (const m of matches) process.stderr.write(`  ${m.id}  (${m.status})\n`);
    process.exit(1);
  }
  return matches[0].id;
}

async function ensureAlive() {
  if (!(await api.health())) {
    process.stderr.write(c.red(`agentgate: cannot reach control plane at ${BASE_URL}\n`));
    process.stderr.write(c.dim(`Set AGENTGATE_URL or start the control plane:\n  node packages/control-plane/dist/index.js\n`));
    process.exit(2);
  }
}

async function cmdHealth() {
  const ok = await api.health();
  process.stdout.write(ok ? c.green(`ok — ${BASE_URL}\n`) : c.red(`unreachable — ${BASE_URL}\n`));
  process.exit(ok ? 0 : 2);
}

async function cmdList(flags: Record<string, string | boolean>) {
  await ensureAlive();
  const status = (flags.status as string) ?? "pending";
  const rows = await api.list(status === "all" ? undefined : status, 100);
  process.stdout.write(renderTable(rows) + "\n");
}

async function cmdShow(positional: string[]) {
  await ensureAlive();
  const idArg = positional[0];
  if (!idArg) { process.stderr.write("usage: agentgate show <id>\n"); process.exit(1); }
  const id = await resolveId(idArg);
  try {
    const a = await api.get(id);
    process.stdout.write(renderApprovalCard(a) + "\n\n");
    process.stdout.write(c.dim(`status: ${a.status}`));
    if (a.decidedBy) process.stdout.write(c.dim(`  by: ${a.decidedBy}`));
    if (a.decisionReason) process.stdout.write(c.dim(`  reason: ${a.decisionReason}`));
    process.stdout.write("\n");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      process.stderr.write(c.red(`approval not found: ${id}\n`));
      process.exit(1);
    }
    throw err;
  }
}

async function decide(approved: boolean, positional: string[], flags: Record<string, string | boolean>) {
  await ensureAlive();
  const idArg = positional[0];
  if (!idArg) { process.stderr.write(`usage: agentgate ${approved ? "approve" : "deny"} <id> [--reason "..."]\n`); process.exit(1); }
  const id = await resolveId(idArg);
  const reason = (flags.reason as string) ?? undefined;
  try {
    const a = await api.decide(id, approved, ME, reason);
    const tag = approved ? c.green("✓ approved") : c.red("✗ denied");
    process.stdout.write(`${tag} ${c.dim(a.id.slice(0, 8))} by ${ME}\n`);
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(c.red(err.message) + "\n");
      process.exit(2);
    }
    throw err;
  }
}

async function cmdAudit(flags: Record<string, string | boolean>) {
  await ensureAlive();
  const limit = parseInt((flags.limit as string) ?? "30", 10);
  const rows = (await api.audit()).slice(0, limit);
  for (const r of rows) {
    const ev = r.event === "approval.created" ? c.cyan(r.event) : r.event === "approval.approved" ? c.green(r.event) : r.event === "approval.denied" ? c.red(r.event) : r.event;
    process.stdout.write(`${c.dim(r.createdAt)}  ${ev}  ${c.dim(r.approvalId.slice(0, 8))}  ${c.blue(r.actor ?? "")}\n`);
  }
}

// ----- watch: live tail with inline y/n -----

type PromptChoice = "approve" | "deny" | "skip";

function promptDecision(a: Approval): Promise<PromptChoice | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const ask = () => {
      rl.question(
        c.bold(`\nDecide #${a.id.slice(0, 8)}: ${c.green("[y]")} approve / ${c.red("[n]")} deny / ${c.dim("[s]")} skip / ${c.dim("[q]")} quit  ▸ `),
        (raw) => {
          const ans = raw.trim().toLowerCase();
          if (ans === "y" || ans === "yes" || ans === "approve") { rl.close(); resolve("approve"); }
          else if (ans === "n" || ans === "no" || ans === "deny") { rl.close(); resolve("deny"); }
          else if (ans === "s" || ans === "skip" || ans === "") { rl.close(); resolve("skip"); }
          else if (ans === "q" || ans === "quit" || ans === "exit") { rl.close(); resolve(null); }
          else { process.stdout.write(c.dim("(use y / n / s / q)\n")); ask(); }
        },
      );
    };
    ask();
  });
}

async function maybeReason(choice: "approve" | "deny"): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(c.dim(`reason (optional, enter to skip) ▸ `), (raw) => {
      rl.close();
      const r = raw.trim();
      resolve(r.length ? r : undefined);
    });
  });
}

async function cmdWatch(flags: Record<string, string | boolean>) {
  await ensureAlive();
  const includeLow = !!flags["include-low"];
  process.stdout.write(c.dim(`agentgate watch — connected to ${BASE_URL}\n`));
  process.stdout.write(c.dim(`I am: ${ME}    (Ctrl+C to exit)\n`));

  // Drain anything currently pending so the operator sees backlog first.
  const pending = await api.list("pending", 50);
  if (pending.length) {
    process.stdout.write(c.dim(`\n— ${pending.length} pending — \n`));
    for (const a of pending) {
      if (!includeLow && a.metadata.severity === "low") continue;
      await handleOne(a);
    }
  }

  process.stdout.write(c.dim(`\n— waiting for new approvals — \n`));
  const seen = new Set<string>(pending.map((a) => a.id));
  for await (const ev of streamEvents(BASE_URL)) {
    const e = ev as { type?: string; approvalId?: string };
    if (e.type !== "approval.created" || !e.approvalId) continue;
    if (seen.has(e.approvalId)) continue;
    seen.add(e.approvalId);
    try {
      const a = await api.get(e.approvalId);
      if (!includeLow && a.metadata.severity === "low") continue;
      if (a.status !== "pending") continue;
      await handleOne(a);
    } catch (err) {
      process.stderr.write(c.red(`fetch failed: ${(err as Error).message}\n`));
    }
  }
}

async function handleOne(a: Approval) {
  process.stdout.write("\n" + renderApprovalCard(a) + "\n");
  const choice = await promptDecision(a);
  if (choice === null) {
    process.stdout.write(c.dim("bye\n"));
    process.exit(0);
  }
  if (choice === "skip") {
    process.stdout.write(c.dim("(skipped — still pending; decide later via dashboard or `agentgate approve/deny`)\n"));
    return;
  }
  const reason = await maybeReason(choice);
  try {
    const updated = await api.decide(a.id, choice === "approve", ME, reason);
    const tag = choice === "approve" ? c.green("✓ approved") : c.red("✗ denied");
    process.stdout.write(`${tag} ${c.dim(updated.id.slice(0, 8))}\n`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      process.stdout.write(c.yellow(`(already decided)\n`));
    } else {
      process.stderr.write(c.red(`decide failed: ${(err as Error).message}\n`));
    }
  }
}

// ----- main -----

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") usage();

  const cmd = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  switch (cmd) {
    case "health": return cmdHealth();
    case "list": return cmdList(flags);
    case "show": return cmdShow(positional);
    case "approve": return decide(true, positional, flags);
    case "deny": return decide(false, positional, flags);
    case "audit": return cmdAudit(flags);
    case "watch": return cmdWatch(flags);
    default:
      process.stderr.write(c.red(`unknown command: ${cmd}\n`));
      usage(1);
  }
}

main().catch((err) => {
  process.stderr.write(c.red(`fatal: ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
