import type { Risk, ScanSignal, Severity, RegistryMeta } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const RISK_RANK: Record<Risk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function bumpRisk(current: Risk, target: Risk): Risk {
  return RISK_RANK[target] > RISK_RANK[current] ? target : current;
}

// Packages above this weekly download bar are widely adopted — recent
// releases reflect normal patch cadence, not novelty risk.
const HIGH_TRAFFIC_THRESHOLD = 1_000_000;

export function deriveContextSignals(meta: RegistryMeta): ScanSignal[] {
  const out: ScanSignal[] = [];
  const highTraffic =
    meta.weeklyDownloads !== undefined && meta.weeklyDownloads >= HIGH_TRAFFIC_THRESHOLD;

  if (
    !highTraffic &&
    meta.ageDays !== undefined &&
    meta.ageDays >= 0 &&
    meta.ageDays < 30
  ) {
    out.push({
      kind: "new_package",
      severity: meta.ageDays < 7 ? "high" : "medium",
      message: `published ${meta.ageDays} day(s) ago`,
      data: { ageDays: meta.ageDays, publishedAt: meta.publishedAt },
    });
  }

  if (meta.weeklyDownloads !== undefined && meta.weeklyDownloads < 1000) {
    out.push({
      kind: "low_downloads",
      severity: meta.weeklyDownloads < 100 ? "medium" : "low",
      message: `only ${meta.weeklyDownloads} download(s) last week`,
      data: { weeklyDownloads: meta.weeklyDownloads },
    });
  }

  if (!highTraffic && meta.maintainers !== undefined && meta.maintainers <= 1) {
    out.push({
      kind: "sole_maintainer",
      severity: "low",
      message: "package has a single maintainer",
      data: { maintainers: meta.maintainers },
    });
  }

  if (meta.deprecated) {
    out.push({
      kind: "deprecated",
      severity: "medium",
      message: "package is marked as deprecated/yanked",
    });
  }

  if (meta.hasInstallScripts && meta.installScripts) {
    out.push({
      kind: "post_install_script",
      severity: "high",
      message: `defines install hooks: ${Object.keys(meta.installScripts).join(", ")}`,
      data: { scripts: meta.installScripts },
    });
  }

  return out;
}

export function scoreRisk(signals: ScanSignal[]): Risk {
  let risk: Risk = "low";

  let hasCritical = false;
  let highCveCount = 0;
  let typoSquatHigh = false;
  let postInstallNew = false;

  let newPackage = false;
  let postInstall = false;

  for (const s of signals) {
    if (s.kind === "cve" && s.severity === "critical") hasCritical = true;
    if (s.kind === "cve" && s.severity === "high") highCveCount++;
    if (s.kind === "typosquat" && s.severity === "high") typoSquatHigh = true;
    if (s.kind === "new_package") newPackage = true;
    if (s.kind === "post_install_script") postInstall = true;
  }

  postInstallNew = postInstall && newPackage;

  if (hasCritical) risk = bumpRisk(risk, "critical");
  if (typoSquatHigh) risk = bumpRisk(risk, "critical");
  if (postInstallNew) risk = bumpRisk(risk, "critical");

  if (highCveCount > 0) risk = bumpRisk(risk, "high");
  if (postInstall && risk === "low") risk = bumpRisk(risk, "high");

  // Aggregate: any two medium+ signals → at least medium
  const mediumPlus = signals.filter((s) => SEVERITY_RANK[s.severity] >= 2).length;
  if (mediumPlus >= 2) risk = bumpRisk(risk, "medium");
  if (mediumPlus >= 1 && risk === "low") risk = bumpRisk(risk, "medium");

  return risk;
}
