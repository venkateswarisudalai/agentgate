import type { Approval } from "./api.js";
import { c, severityColor, recoverableColor } from "./colors.js";

function fmtTs(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  return d.toLocaleTimeString([], { hour12: false });
}

export function renderShortLine(a: Approval): string {
  const sev = severityColor(a.metadata.severity)((a.metadata.severity ?? "?").padEnd(6));
  const cat = c.cyan((a.metadata.category ?? "?").padEnd(10));
  const id = c.dim(a.id.slice(0, 8));
  const agent = c.blue(a.agent);
  const headline = a.metadata.impact?.headline ?? a.reason;
  const status = a.status === "approved" ? c.green("✓") : a.status === "denied" ? c.red("✗") : c.yellow("⏳");
  return `${status} ${id} ${sev} ${cat} ${agent}  ${headline}`;
}

export function renderApprovalCard(a: Approval): string {
  const sev = a.metadata.severity ?? "?";
  const cat = a.metadata.category ?? "?";
  const ruleId = a.metadata.ruleId ?? "?";
  const rec = a.metadata.impact?.recoverable;
  const headline = a.metadata.impact?.headline ?? a.reason;
  const consequences = a.metadata.impact?.consequences ?? [];
  const targets = a.metadata.impact?.targets;
  const cmd =
    (a.metadata.toolInput as { command?: string } | undefined)?.command ??
    (a.metadata.toolInput as { file_path?: string } | undefined)?.file_path ??
    "";

  const lines: string[] = [];
  const sevTag = severityColor(sev)(c.bold(`[${sev.toUpperCase()}]`));
  const recTag = rec ? recoverableColor(rec)(`recoverable: ${rec}`) : "";
  lines.push("");
  lines.push(`${sevTag}  ${c.cyan(cat)}/${c.cyan(ruleId)}  ${recTag}  ${c.dim(`#${a.id.slice(0, 8)}`)}  ${c.dim(fmtTs(a.createdAt))}`);
  lines.push(`${c.blue(c.bold(a.agent))} → ${c.yellow(a.action)}`);
  lines.push(c.bold(headline));
  for (const cz of consequences) lines.push(`  ${c.dim("•")} ${cz}`);
  if (cmd) lines.push(`  ${c.dim("$")} ${c.bold(cmd)}`);
  if (targets && Object.keys(targets).length) {
    const t = Object.entries(targets).map(([k, v]) => `${c.dim(k + "=")}${v}`).join(c.dim(", "));
    lines.push(`  ${c.dim("targets:")} ${t}`);
  }
  return lines.join("\n");
}

export function renderTable(rows: Approval[]): string {
  if (rows.length === 0) return c.dim("(no approvals)");
  return rows.map(renderShortLine).join("\n");
}
