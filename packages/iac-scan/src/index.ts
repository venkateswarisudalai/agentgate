export { parseTerraformPlan } from "./terraform.js";
export { parseKubectlDryRun, type KubectlMode } from "./kubectl.js";
export { buildBlastRadius, scoreRisk, deriveSignals } from "./score.js";
export type {
  BlastRadius,
  ChangeKind,
  Counts,
  IacChange,
  IacRiskSignal,
  Risk,
  Severity,
} from "./types.js";
