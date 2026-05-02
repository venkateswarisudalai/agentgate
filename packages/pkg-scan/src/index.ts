import { queryOsv } from "./osv.js";
import { fetchNpmMetadata } from "./npm.js";
import { fetchPypiMetadata } from "./pypi.js";
import { checkTyposquat } from "./typosquat.js";
import { deriveContextSignals, scoreRisk } from "./score.js";
import type { ScanInput, ScanResult, ScanSignal } from "./types.js";

export type {
  ScanInput,
  ScanResult,
  ScanSignal,
  Risk,
  Ecosystem,
  Severity,
  SignalKind,
  RegistryMeta,
} from "./types.js";

export type ScanOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;

export async function scan(
  input: ScanInput,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const meta =
      input.ecosystem === "npm"
        ? await fetchNpmMetadata(input.name, input.version, fetchImpl, ctrl.signal)
        : await fetchPypiMetadata(input.name, input.version, fetchImpl, ctrl.signal);

    const cveSignals = await queryOsv(
      input.ecosystem,
      input.name,
      meta.resolvedVersion === "unknown" ? input.version : meta.resolvedVersion,
      fetchImpl,
      ctrl.signal,
    );

    const signals: ScanSignal[] = [];
    const typo = checkTyposquat(input.name, input.ecosystem);
    if (typo) signals.push(typo);
    signals.push(...deriveContextSignals(meta.meta));
    signals.push(...cveSignals);
    signals.push(...meta.signals);

    return {
      ecosystem: input.ecosystem,
      name: input.name,
      version: meta.resolvedVersion,
      risk: scoreRisk(signals),
      signals,
      metadata: meta.meta,
      scannedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function scanMany(
  inputs: ScanInput[],
  opts: ScanOptions = {},
): Promise<ScanResult[]> {
  return Promise.all(inputs.map((i) => scan(i, opts)));
}
