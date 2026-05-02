import type { Ecosystem } from "@agentgate/pkg-scan";

export type InstallSpec = { name: string; version?: string };
export type InstallIntent = { ecosystem: Ecosystem; manager: string; packages: InstallSpec[] };

const FLAG_TAKES_VALUE = new Set([
  "-w", "--workspace",
  "--prefix",
  "--registry",
  "-r", "--requirement",
  "-i", "--index-url",
  "--extra-index-url",
  "-c", "--constraint",
  "-e", "--editable",
  "-t", "--target",
  "--tag",
  "--save-prefix",
  "--package",
]);

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function stripFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-")) {
      out.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const flagName = eq >= 0 ? t.slice(0, eq) : t;
    if (eq < 0 && FLAG_TAKES_VALUE.has(flagName)) {
      i++; // consume value
    }
  }
  return out;
}

function parseNpmSpec(spec: string): InstallSpec | null {
  // Skip URLs, file paths, git refs, tarballs
  if (/^(https?:|git\+|file:|github:|[a-z]+:)/.test(spec)) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.endsWith(".tgz") || spec.endsWith(".tar.gz")) return null;

  // scoped: @scope/name@version
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0) return null;
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf("@");
    if (at < 0) return { name: spec };
    return { name: spec.slice(0, slash + 1 + at), version: rest.slice(at + 1) };
  }
  const at = spec.indexOf("@");
  if (at < 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function parsePypiSpec(spec: string): InstallSpec | null {
  if (/^(https?:|git\+|file:|[a-z]+:)/.test(spec)) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (/\.(whl|tar\.gz|tar\.bz2|zip)$/i.test(spec)) return null;

  const m = spec.match(/^([A-Za-z0-9_.\-]+)(?:\s*\[[^\]]+\])?\s*(?:([<>=!~]=?|===)\s*([A-Za-z0-9_.\-+*]+))?/);
  if (!m) return null;
  const name = m[1];
  const op = m[2];
  const ver = m[3];
  if (op === "==" || op === "===") return { name, version: ver };
  return { name };
}

const NPM_INSTALL_VERBS = new Set(["install", "i", "add"]);
const PNPM_INSTALL_VERBS = new Set(["add", "install", "i"]);
const YARN_INSTALL_VERBS = new Set(["add"]);
const PIP_INSTALL_VERBS = new Set(["install"]);
const UV_INSTALL_VERBS = new Set(["add", "pip"]);

function detectFromTokens(tokens: string[]): InstallIntent | null {
  if (tokens.length < 2) return null;
  const [bin, ...rest] = tokens;
  const binBase = bin.split("/").pop() ?? bin;

  if (binBase === "npm" || binBase === "pnpm" || binBase === "yarn") {
    const verb = rest[0];
    const verbSet =
      binBase === "npm" ? NPM_INSTALL_VERBS
      : binBase === "pnpm" ? PNPM_INSTALL_VERBS
      : YARN_INSTALL_VERBS;
    if (!verb || !verbSet.has(verb)) return null;
    const args = stripFlags(rest.slice(1));
    if (args.length === 0) return null; // bare install (from package.json)
    const packages = args.map(parseNpmSpec).filter((x): x is InstallSpec => !!x);
    if (packages.length === 0) return null;
    return { ecosystem: "npm", manager: binBase, packages };
  }

  if (binBase === "bun") {
    const verb = rest[0];
    if (verb !== "add" && verb !== "install" && verb !== "i") return null;
    const args = stripFlags(rest.slice(1));
    if (args.length === 0) return null;
    const packages = args.map(parseNpmSpec).filter((x): x is InstallSpec => !!x);
    if (packages.length === 0) return null;
    return { ecosystem: "npm", manager: "bun", packages };
  }

  if (binBase === "pip" || binBase === "pip3" || binBase === "pipx") {
    const verb = rest[0];
    if (!PIP_INSTALL_VERBS.has(verb)) return null;
    const args = stripFlags(rest.slice(1));
    const packages = args.map(parsePypiSpec).filter((x): x is InstallSpec => !!x);
    if (packages.length === 0) return null;
    return { ecosystem: "pypi", manager: binBase, packages };
  }

  if (binBase === "python" || binBase === "python3") {
    // python -m pip install <pkg>
    const idx = rest.indexOf("-m");
    if (idx < 0 || rest[idx + 1] !== "pip") return null;
    const after = rest.slice(idx + 2);
    if (after[0] !== "install") return null;
    const args = stripFlags(after.slice(1));
    const packages = args.map(parsePypiSpec).filter((x): x is InstallSpec => !!x);
    if (packages.length === 0) return null;
    return { ecosystem: "pypi", manager: `${binBase} -m pip`, packages };
  }

  if (binBase === "uv") {
    // `uv pip install x` or `uv add x`
    const verb = rest[0];
    if (verb === "pip" && rest[1] === "install") {
      const args = stripFlags(rest.slice(2));
      const packages = args.map(parsePypiSpec).filter((x): x is InstallSpec => !!x);
      if (packages.length === 0) return null;
      return { ecosystem: "pypi", manager: "uv pip", packages };
    }
    if (verb === "add") {
      const args = stripFlags(rest.slice(1));
      const packages = args.map(parsePypiSpec).filter((x): x is InstallSpec => !!x);
      if (packages.length === 0) return null;
      return { ecosystem: "pypi", manager: "uv", packages };
    }
    return null;
  }

  if (binBase === "poetry") {
    if (rest[0] !== "add") return null;
    const args = stripFlags(rest.slice(1));
    const packages = args.map(parsePypiSpec).filter((x): x is InstallSpec => !!x);
    if (packages.length === 0) return null;
    return { ecosystem: "pypi", manager: "poetry", packages };
  }

  return null;
}

export function detectInstall(command: string): InstallIntent | null {
  // Split on shell separators conservatively; check each segment.
  const segments = command.split(/&&|;|\|\|/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    const intent = detectFromTokens(tokens);
    if (intent) return intent;
  }
  return null;
}
