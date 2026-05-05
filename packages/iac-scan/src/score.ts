import type { BlastRadius, IacChange, IacRiskSignal, Risk, Severity } from "./types.js";

const SEV_RANK: Record<Severity, number> = {
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

function bumpRisk(cur: Risk, target: Risk): Risk {
  return RISK_RANK[target] > RISK_RANK[cur] ? target : cur;
}

// Resources whose deletion is typically irrecoverable.
const DATA_LOSS_TYPES = new Set<string>([
  "aws_s3_bucket",
  "aws_dynamodb_table",
  "aws_rds_cluster",
  "aws_rds_instance",
  "aws_db_instance",
  "aws_db_cluster",
  "aws_ebs_volume",
  "aws_efs_file_system",
  "google_storage_bucket",
  "google_sql_database_instance",
  "google_compute_disk",
  "azurerm_storage_account",
  "azurerm_sql_database",
  "azurerm_postgresql_server",
  "kubernetes_persistent_volume",
  "kubernetes_persistent_volume_claim",
]);

const IAM_TYPE_PATTERNS = [
  /^aws_iam_/i,
  /^google_(?:project_)?iam_/i,
  /^azurerm_role_/i,
  /^kubernetes_(?:cluster_)?role/i,
  /service_account/i,
];

const SECURITY_GROUP_TYPES = new Set<string>([
  "aws_security_group",
  "aws_security_group_rule",
  "aws_vpc_security_group_ingress_rule",
  "google_compute_firewall",
  "azurerm_network_security_group",
  "azurerm_network_security_rule",
]);

const STATEFUL_KUBE_KINDS = new Set<string>([
  "StatefulSet",
  "PersistentVolume",
  "PersistentVolumeClaim",
  "Namespace",
  "CustomResourceDefinition",
]);

const KUBE_DESTRUCTIVE_KINDS = new Set<string>([
  "Namespace",
  "PersistentVolumeClaim",
  "PersistentVolume",
  "CustomResourceDefinition",
  "StorageClass",
]);

function isIamType(t: string): boolean {
  return IAM_TYPE_PATTERNS.some((re) => re.test(t));
}

function nameLooksProd(name: string): boolean {
  return /\b(prod|production|prd|live)\b/i.test(name);
}

export function deriveSignals(
  changes: IacChange[],
  source: "terraform" | "kubectl",
): IacRiskSignal[] {
  const out: IacRiskSignal[] = [];

  for (const c of changes) {
    if (c.kind === "destroy") {
      out.push({
        kind: "destroy_resource",
        severity: "high",
        message: `destroying ${c.resourceType} ${c.resourceName}`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName },
      });
    }
    if (c.kind === "replace") {
      out.push({
        kind: "replace_resource",
        severity: "high",
        message: `replacing ${c.resourceType} ${c.resourceName} (destroy + create)`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName },
      });
    }
    if (
      (c.kind === "destroy" || c.kind === "replace") &&
      DATA_LOSS_TYPES.has(c.resourceType)
    ) {
      out.push({
        kind: "data_loss_risk",
        severity: "critical",
        message: `${c.resourceType} ${c.resourceName} is a stateful resource — ${c.kind} can lose data permanently`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName },
      });
    }
    if (isIamType(c.resourceType) && c.kind !== "noop") {
      out.push({
        kind: "iam_change",
        severity: c.kind === "destroy" || c.kind === "replace" ? "high" : "medium",
        message: `IAM change on ${c.resourceType} ${c.resourceName} (${c.kind})`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName, kind: c.kind },
      });
    }
    if (SECURITY_GROUP_TYPES.has(c.resourceType) && c.kind !== "noop") {
      out.push({
        kind: "security_group_open",
        severity: "high",
        message: `network/security-group change on ${c.resourceType} ${c.resourceName}`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName, kind: c.kind },
      });
    }
    if (source === "kubectl") {
      if (KUBE_DESTRUCTIVE_KINDS.has(c.resourceType) && c.kind === "destroy") {
        out.push({
          kind: "kubernetes_destructive",
          severity: "critical",
          message: `Kubernetes ${c.resourceType} ${c.resourceName} deletion cascades`,
          data: { resourceType: c.resourceType, resourceName: c.resourceName },
        });
      }
      if (STATEFUL_KUBE_KINDS.has(c.resourceType) && c.kind !== "noop") {
        out.push({
          kind: "stateful_resource_change",
          severity: c.kind === "destroy" ? "critical" : "high",
          message: `change on stateful Kubernetes ${c.resourceType} ${c.resourceName}`,
          data: { resourceType: c.resourceType, resourceName: c.resourceName, kind: c.kind },
        });
      }
    }
    if (nameLooksProd(c.resourceName) && (c.kind === "destroy" || c.kind === "replace")) {
      out.push({
        kind: "production_target",
        severity: "critical",
        message: `${c.kind} on ${c.resourceName} — name suggests production`,
        data: { resourceType: c.resourceType, resourceName: c.resourceName, kind: c.kind },
      });
    }
  }

  // Scope explosion: a single plan touching too many resources is its own risk.
  const writeCount = changes.filter(
    (c) => c.kind === "create" || c.kind === "update" || c.kind === "destroy" || c.kind === "replace",
  ).length;
  if (writeCount >= 50) {
    out.push({
      kind: "scope_explosion",
      severity: "high",
      message: `plan touches ${writeCount} resources`,
      data: { writeCount },
    });
  } else if (writeCount >= 20) {
    out.push({
      kind: "scope_explosion",
      severity: "medium",
      message: `plan touches ${writeCount} resources`,
      data: { writeCount },
    });
  }

  return out;
}

export function scoreRisk(signals: IacRiskSignal[]): Risk {
  let risk: Risk = "low";
  let highs = 0;
  let mediums = 0;
  for (const s of signals) {
    if (s.severity === "critical") risk = bumpRisk(risk, "critical");
    if (s.severity === "high") highs++;
    if (s.severity === "medium") mediums++;
  }
  if (risk === "critical") return risk;
  if (highs >= 1) risk = bumpRisk(risk, "high");
  if (mediums >= 2) risk = bumpRisk(risk, "medium");
  if (mediums >= 1 && risk === "low") risk = bumpRisk(risk, "medium");
  return risk;
}

export function buildBlastRadius(
  changes: IacChange[],
  source: "terraform" | "kubectl",
): BlastRadius {
  const counts = changes.reduce(
    (acc, c) => {
      acc[c.kind]++;
      return acc;
    },
    { create: 0, update: 0, destroy: 0, replace: 0, noop: 0 },
  );
  const signals = deriveSignals(changes, source);
  const risk = scoreRisk(signals);
  const summary =
    [
      counts.create ? `${counts.create} to create` : null,
      counts.update ? `${counts.update} to update` : null,
      counts.destroy ? `${counts.destroy} to destroy` : null,
      counts.replace ? `${counts.replace} to replace` : null,
    ]
      .filter(Boolean)
      .join(", ") || "no changes";
  return { source, summary, counts, changes, signals, risk };
}

// expose for tests
export const _internal = { isIamType, nameLooksProd, SEV_RANK };
