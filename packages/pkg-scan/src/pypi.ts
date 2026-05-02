import type { RegistryMeta, ScanSignal } from "./types.js";

const PYPI_BASE = "https://pypi.org/pypi";
const PYPISTATS = "https://pypistats.org/api/packages";

type PypiInfo = {
  name?: string;
  version?: string;
  summary?: string;
  home_page?: string;
  project_url?: string;
  project_urls?: Record<string, string>;
  yanked?: boolean;
};

type PypiResponse = {
  info?: PypiInfo;
  releases?: Record<string, Array<{ upload_time?: string; upload_time_iso_8601?: string }>>;
  urls?: Array<{ upload_time?: string; upload_time_iso_8601?: string }>;
};

export async function fetchPypiMetadata(
  name: string,
  version: string | undefined,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ resolvedVersion: string; meta: RegistryMeta; signals: ScanSignal[] }> {
  const signals: ScanSignal[] = [];
  const url = version
    ? `${PYPI_BASE}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`
    : `${PYPI_BASE}/${encodeURIComponent(name)}/json`;
  let pypi: PypiResponse | null = null;
  try {
    const res = await fetchImpl(url, { signal });
    if (res.ok) {
      pypi = (await res.json()) as PypiResponse;
    } else if (res.status === 404) {
      signals.push({
        kind: "scan_error",
        severity: "high",
        message: `package ${name} not found on PyPI`,
      });
    } else {
      signals.push({
        kind: "scan_error",
        severity: "info",
        message: `PyPI returned ${res.status}`,
      });
    }
  } catch (err) {
    signals.push({
      kind: "scan_error",
      severity: "info",
      message: `PyPI unreachable: ${(err as Error).message}`,
    });
  }

  if (!pypi) {
    return { resolvedVersion: version ?? "unknown", meta: {}, signals };
  }

  const resolved = pypi.info?.version ?? version ?? "unknown";
  const releaseFiles = pypi.releases?.[resolved] ?? pypi.urls ?? [];
  const publishedAt =
    releaseFiles[0]?.upload_time_iso_8601 ?? releaseFiles[0]?.upload_time;
  const ageDays = publishedAt
    ? Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86_400_000)
    : undefined;

  let weekly: number | undefined;
  try {
    const dRes = await fetchImpl(
      `${PYPISTATS}/${encodeURIComponent(name)}/recent`,
      { signal },
    );
    if (dRes.ok) {
      const j = (await dRes.json()) as { data?: { last_week?: number } };
      weekly = j.data?.last_week;
    }
  } catch {
    // soft-fail
  }

  const homepage =
    pypi.info?.home_page ||
    pypi.info?.project_urls?.Homepage ||
    pypi.info?.project_urls?.["Home"] ||
    undefined;
  const repository =
    pypi.info?.project_urls?.Repository ||
    pypi.info?.project_urls?.Source ||
    pypi.info?.project_urls?.["Source Code"] ||
    pypi.info?.project_urls?.["Github"] ||
    undefined;

  const meta: RegistryMeta = {
    publishedAt,
    ageDays,
    weeklyDownloads: weekly,
    homepage,
    repository,
    description: pypi.info?.summary,
    deprecated: pypi.info?.yanked === true,
    // PyPI install scripts (setup.py) are inherently a yes for source dists,
    // but signal noise is high — surface only when name+age suggests risk.
    hasInstallScripts: undefined,
  };

  return { resolvedVersion: resolved, meta, signals };
}
