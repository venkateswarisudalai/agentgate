import type { RegistryMeta, ScanSignal } from "./types.js";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";

type NpmPackument = {
  name: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, NpmVersion>;
  maintainers?: Array<{ name: string; email: string }>;
  homepage?: string;
  repository?: { url?: string } | string;
  description?: string;
};

type NpmVersion = {
  scripts?: Record<string, string>;
  deprecated?: string;
};

const INSTALL_SCRIPT_HOOKS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
]);

export async function fetchNpmMetadata(
  name: string,
  version: string | undefined,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ resolvedVersion: string; meta: RegistryMeta; signals: ScanSignal[] }> {
  const signals: ScanSignal[] = [];
  const url = `${REGISTRY}/${encodeURIComponent(name).replace(/^%40/, "@")}`;
  let pack: NpmPackument | null = null;
  try {
    const res = await fetchImpl(url, { signal });
    if (res.ok) {
      pack = (await res.json()) as NpmPackument;
    } else if (res.status === 404) {
      signals.push({
        kind: "scan_error",
        severity: "high",
        message: `package ${name} not found on npm registry`,
      });
    } else {
      signals.push({
        kind: "scan_error",
        severity: "info",
        message: `npm registry returned ${res.status}`,
      });
    }
  } catch (err) {
    signals.push({
      kind: "scan_error",
      severity: "info",
      message: `npm registry unreachable: ${(err as Error).message}`,
    });
  }

  if (!pack) {
    return { resolvedVersion: version ?? "unknown", meta: {}, signals };
  }

  const resolved =
    version && pack.versions?.[version] ? version : pack["dist-tags"]?.latest ?? "unknown";
  const versionMeta = pack.versions?.[resolved];
  const publishedAt = pack.time?.[resolved];
  const ageDays = publishedAt
    ? Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86_400_000)
    : undefined;

  const installScripts: Record<string, string> = {};
  for (const [name, body] of Object.entries(versionMeta?.scripts ?? {})) {
    if (INSTALL_SCRIPT_HOOKS.has(name)) installScripts[name] = body;
  }

  let weekly: number | undefined;
  try {
    const dRes = await fetchImpl(`${DOWNLOADS}/${name}`, { signal });
    if (dRes.ok) {
      const j = (await dRes.json()) as { downloads?: number };
      weekly = j.downloads;
    }
  } catch {
    // soft-fail; just don't include downloads
  }

  const repoRaw =
    typeof pack.repository === "string" ? pack.repository : pack.repository?.url;

  const meta: RegistryMeta = {
    publishedAt,
    ageDays,
    weeklyDownloads: weekly,
    maintainers: pack.maintainers?.length,
    homepage: pack.homepage,
    repository: repoRaw,
    description: pack.description,
    deprecated: typeof versionMeta?.deprecated === "string",
    hasInstallScripts: Object.keys(installScripts).length > 0,
    installScripts: Object.keys(installScripts).length > 0 ? installScripts : undefined,
  };

  return { resolvedVersion: resolved, meta, signals };
}
