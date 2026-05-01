export type Ecosystem = "npm" | "pypi";

export type Risk = "low" | "medium" | "high" | "critical";

export type SignalKind =
  | "cve"
  | "typosquat"
  | "post_install_script"
  | "new_package"
  | "low_downloads"
  | "sole_maintainer"
  | "deprecated"
  | "scan_error";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type ScanSignal = {
  kind: SignalKind;
  severity: Severity;
  message: string;
  data?: Record<string, unknown>;
};

export type ScanInput = {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
};

export type RegistryMeta = {
  publishedAt?: string;
  ageDays?: number;
  weeklyDownloads?: number;
  maintainers?: number;
  homepage?: string;
  repository?: string;
  description?: string;
  deprecated?: boolean;
  hasInstallScripts?: boolean;
  installScripts?: Record<string, string>;
};

export type ScanResult = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  risk: Risk;
  signals: ScanSignal[];
  metadata: RegistryMeta;
  scannedAt: string;
};
