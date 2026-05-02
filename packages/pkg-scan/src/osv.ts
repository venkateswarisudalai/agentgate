import type { Ecosystem, ScanSignal, Severity } from "./types.js";

const OSV_API = "https://api.osv.dev/v1/query";

type OsvSeverity = { type: string; score: string };
type OsvVuln = {
  id: string;
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  database_specific?: { severity?: string };
};
type OsvResponse = { vulns?: OsvVuln[] };

const ECOSYSTEM_NAME: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
};

function cvssScore(vuln: OsvVuln): number | null {
  const sev = vuln.severity?.find((s) => s.type === "CVSS_V3" || s.type === "CVSS_V4");
  if (!sev) return null;
  const m = sev.score.match(/\/AV:[A-Z].*\/A:[A-Z]/);
  if (!m) return null;
  const baseMatch = sev.score.match(/CVSS:[\d.]+\/.*?(?:\/|$)/);
  if (!baseMatch) return null;
  const num = parseFloat(sev.score.split("/")[0]);
  return isNaN(num) ? null : num;
}

function severityFromVuln(vuln: OsvVuln): Severity {
  const dbSev = vuln.database_specific?.severity?.toLowerCase();
  if (dbSev === "critical") return "critical";
  if (dbSev === "high") return "high";
  if (dbSev === "moderate" || dbSev === "medium") return "medium";
  if (dbSev === "low") return "low";

  const score = cvssScore(vuln);
  if (score == null) return "medium";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export async function queryOsv(
  ecosystem: Ecosystem,
  name: string,
  version?: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ScanSignal[]> {
  const body = {
    package: { name, ecosystem: ECOSYSTEM_NAME[ecosystem] },
    ...(version ? { version } : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(OSV_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    return [
      {
        kind: "scan_error",
        severity: "info",
        message: `OSV unreachable: ${(err as Error).message}`,
      },
    ];
  }
  if (!res.ok) {
    return [
      {
        kind: "scan_error",
        severity: "info",
        message: `OSV returned ${res.status}`,
      },
    ];
  }
  const data = (await res.json()) as OsvResponse;
  const vulns = data.vulns ?? [];
  return vulns.slice(0, 10).map<ScanSignal>((v) => ({
    kind: "cve",
    severity: severityFromVuln(v),
    message: `${v.id}: ${v.summary ?? "(no summary)"}`,
    data: {
      id: v.id,
      summary: v.summary,
      cvss: cvssScore(v),
    },
  }));
}
