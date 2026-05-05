export type ChangeKind = "create" | "update" | "destroy" | "replace" | "noop";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type Risk = "low" | "medium" | "high" | "critical";

export type IacChange = {
  kind: ChangeKind;
  resourceType: string; // e.g. "aws_s3_bucket", "Deployment", "Service"
  resourceName: string; // e.g. "primary", "default/api"
  // List of attribute paths that changed (when known); empty for create/destroy
  changedAttributes?: string[];
  // The change is destructive if it removes data or breaks dependents
  destructive: boolean;
  // Free-form provider/source tag (e.g. "terraform", "kubectl")
  source: string;
};

export type IacRiskSignal = {
  kind:
    | "destroy_resource"
    | "replace_resource"
    | "iam_change"
    | "security_group_open"
    | "data_loss_risk"
    | "stateful_resource_change"
    | "production_target"
    | "scope_explosion"
    | "policy_violation"
    | "kubernetes_destructive";
  severity: Severity;
  message: string;
  data?: Record<string, unknown>;
};

export type Counts = {
  create: number;
  update: number;
  destroy: number;
  replace: number;
  noop: number;
};

export type BlastRadius = {
  source: "terraform" | "kubectl";
  summary: string;
  counts: Counts;
  changes: IacChange[];
  signals: IacRiskSignal[];
  risk: Risk;
};
