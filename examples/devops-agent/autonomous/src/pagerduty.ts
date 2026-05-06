import crypto from "node:crypto";
import { readFileSync } from "node:fs";

export type IncidentContext = {
  incidentId: string;
  service: string;
  app: string;
  severity: "P1" | "P2" | "P3" | "P4" | "P5";
  alertType: "crashloop" | "error-rate" | "latency" | "unknown";
  triggeredAt: string;
  summary: string;
  rawAlert: unknown;
};

type ServiceMapping = Record<string, { app: string; namespace?: string }>;

export function loadServiceMapping(path: string): ServiceMapping {
  return JSON.parse(readFileSync(path, "utf-8")) as ServiceMapping;
}

/**
 * PagerDuty signs webhooks with HMAC-SHA256 using a shared secret.
 * Header: X-PagerDuty-Signature: v1=<hex>[,v1=<hex>] (rotation-friendly)
 */
export function verifyPagerDutySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const presented = signatureHeader
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  return presented.some((sig) => timingSafeHexEqual(sig, expected));
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Normalize a PagerDuty v3 webhook payload into our IncidentContext.
 * v3 payloads have shape: { event: { event_type, occurred_at, data: { ... } } }
 */
export function normalizePagerDutyPayload(
  payload: unknown,
  mapping: ServiceMapping,
): IncidentContext | null {
  const event = (payload as { event?: { data?: Record<string, unknown>; occurred_at?: string } })?.event;
  const data = event?.data;
  if (!data) return null;

  const incidentId = String(data.id ?? "unknown");
  const service = String((data.service as { summary?: string } | undefined)?.summary ?? "unknown");
  const summary = String(data.title ?? data.summary ?? "");
  const severity = normalizeSeverity(data.urgency, data.priority);
  const triggeredAt = String(event?.occurred_at ?? new Date().toISOString());

  const mapEntry = mapping[service];
  if (!mapEntry) return null;

  return {
    incidentId,
    service,
    app: mapEntry.app,
    severity,
    alertType: classifyAlert(summary),
    triggeredAt,
    summary,
    rawAlert: payload,
  };
}

function normalizeSeverity(
  urgency: unknown,
  priority: unknown,
): IncidentContext["severity"] {
  const p = (priority as { summary?: string } | undefined)?.summary?.toUpperCase();
  if (p && /^P[1-5]$/.test(p)) return p as IncidentContext["severity"];
  return urgency === "high" ? "P2" : "P3";
}

function classifyAlert(summary: string): IncidentContext["alertType"] {
  const s = summary.toLowerCase();
  if (/crashloop|crash.loop|crash-loop/.test(s)) return "crashloop";
  if (/error.rate|5xx|http.5\d\d|elevated.errors/.test(s)) return "error-rate";
  if (/latency|p9[59]|slow/.test(s)) return "latency";
  return "unknown";
}
