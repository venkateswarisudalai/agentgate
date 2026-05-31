// `agentgate-claude-code-hook init` — one command instead of hand-editing JSON.
// Safely merges the agentgate PreToolUse hook into ~/.claude/settings.json
// (or a project-level .claude/settings.json with --project).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit";

function helpText(): string {
  return `agentgate-claude-code-hook init — install the PreToolUse hook into Claude Code

Usage:
  npx @agentgate/claude-code-hook init [options]

Options:
  --project           Write to ./.claude/settings.json (default: ~/.claude/settings.json)
  --local             Use this checkout's absolute path as the hook command
                      (for testing before the package is published to npm)
  --command <cmd>     Override the hook command entirely
  -h, --help          Show this help

After running, start the control plane and restart Claude Code:
  npx @agentgate/control-plane
`;
}

export function runInit(argv: string[]): never {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(helpText());
    process.exit(0);
  }

  const project = argv.includes("--project");
  const local = argv.includes("--local");
  const settingsPath = project
    ? resolve(process.cwd(), ".claude/settings.json")
    : resolve(homedir(), ".claude/settings.json");

  const cmdIdx = argv.indexOf("--command");
  let command: string;
  if (cmdIdx >= 0 && argv[cmdIdx + 1]) {
    command = argv[cmdIdx + 1];
  } else if (local) {
    // Point at this checkout's compiled hook — stable for pre-publish testing.
    const here = dirname(fileURLToPath(import.meta.url));
    command = `node ${resolve(here, "index.js")}`;
  } else {
    command = "npx -y @agentgate/claude-code-hook";
  }

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8").trim();
    if (raw) {
      try {
        settings = JSON.parse(raw);
      } catch {
        process.stderr.write(
          `✗ ${settingsPath} is not valid JSON. Fix or move it, then re-run.\n`,
        );
        process.exit(1);
      }
    }
  }

  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const pre: any[] = settings.hooks.PreToolUse;

  // Detect any existing agentgate hook across its command forms:
  //   npx -y @agentgate/claude-code-hook | agentgate-claude-code-hook | node …/claude-code-hook/dist/index.js
  const already = pre.some((entry) =>
    (entry?.hooks ?? []).some(
      (h: any) => typeof h?.command === "string" && h.command.includes("claude-code-hook"),
    ),
  );
  if (already) {
    process.stdout.write(
      `✓ agentgate hook already present in ${settingsPath} — nothing to do.\n`,
    );
    process.exit(0);
  }

  pre.push({ matcher: MATCHER, hooks: [{ type: "command", command }] });

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  process.stdout.write(
    `✓ Installed agentgate PreToolUse hook\n` +
      `  file:    ${settingsPath}\n` +
      `  matcher: ${MATCHER}\n` +
      `  command: ${command}\n\n` +
      `Next:\n` +
      `  1. Start the control plane:  npx @agentgate/control-plane\n` +
      `  2. Restart Claude Code (or start a new session).\n` +
      `  3. Ask it to do something destructive — it'll pause for approval.\n`,
  );
  process.exit(0);
}
