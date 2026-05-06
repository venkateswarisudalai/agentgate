import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IncidentContext,
  loadServiceMapping,
  normalizePagerDutyPayload,
  verifyPagerDutySignature,
} from "./pagerduty.js";
import { handleIncident } from "./incident.js";

type Args = {
  port: number;
  fixturePath?: string;
  mappingPath: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.PORT ?? 4100),
    mappingPath: resolve(process.cwd(), "pagerduty-mapping.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fixture") args.fixturePath = argv[++i];
    else if (arg === "--mapping") args.mappingPath = resolve(argv[++i]);
    else if (arg === "--port") args.port = Number(argv[++i]);
  }
  return args;
}

async function runFixture(fixturePath: string, mappingPath: string) {
  const payload = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const mapping = loadServiceMapping(mappingPath);
  const incident = normalizePagerDutyPayload(payload, mapping);
  if (!incident) {
    console.error(`[fixture] could not normalize payload — service not in mapping?`);
    process.exit(1);
  }
  console.log(`[fixture] dispatching incident ${incident.incidentId} (${incident.alertType}) for app=${incident.app}`);
  await handleIncident(incident);
  console.log(`[fixture] done`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.fixturePath) {
    await runFixture(args.fixturePath, args.mappingPath);
    return;
  }

  const mapping = loadServiceMapping(args.mappingPath);
  const secret = process.env.PD_WEBHOOK_SECRET;
  if (!secret) {
    console.error("PD_WEBHOOK_SECRET env var is required for live mode (use --fixture for offline)");
    process.exit(1);
  }

  const app = Fastify({ logger: true });

  app.post("/webhooks/pagerduty", async (req, reply) => {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers["x-pagerduty-signature"] as string | undefined;
    if (!verifyPagerDutySignature(rawBody, signature, secret)) {
      reply.code(401).send({ error: "invalid signature" });
      return;
    }
    const incident = normalizePagerDutyPayload(req.body, mapping);
    if (!incident) {
      reply.code(202).send({ skipped: "service not mapped or payload not actionable" });
      return;
    }
    // Dispatch async — return 200 fast so PD doesn't retry.
    handleIncident(incident).catch((err: unknown) => {
      app.log.error({ err, incidentId: incident.incidentId }, "incident handling failed");
    });
    reply.code(202).send({ accepted: true, incidentId: incident.incidentId });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.listen({ port: args.port, host: "0.0.0.0" });
  console.log(`[server] listening on :${args.port}`);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});

export type { IncidentContext };
