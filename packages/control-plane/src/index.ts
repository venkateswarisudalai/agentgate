#!/usr/bin/env node
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerDemoRoutes } from "./routes-demo.js";
import { seedDemoPolicies } from "./demo/seed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
// Default the DB to the caller's working directory so `npx @agentgate/control-plane`
// works from anywhere (writing inside an npx/global node_modules dir is read-only or
// ephemeral). Override with AGENTGATE_DB.
const DB_PATH = process.env.AGENTGATE_DB ?? resolve(process.cwd(), "agentgate.db");
const PUBLIC_DIR = resolve(__dirname, "../public");
const PUBLIC_BASE_URL =
  process.env.AGENTGATE_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

async function main() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const db = openDb(DB_PATH);

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });
  registerRoutes(app, db);
  registerDemoRoutes(app, db, PUBLIC_BASE_URL);

  // Demo policies are idempotent — safe to run on every boot. They only ever
  // match agents prefixed with `demo:` so they cannot affect real traffic.
  const seeded = seedDemoPolicies(db);
  if (seeded.inserted > 0) {
    app.log.info(`seeded ${seeded.inserted} demo policies (${seeded.skipped} already present)`);
  }

  app.addHook("onClose", async () => {
    db.close();
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`agentgate control plane listening on http://${HOST}:${PORT}`);
    app.log.info(`dashboard:  http://127.0.0.1:${PORT}/`);
    app.log.info(`demo mode:  http://127.0.0.1:${PORT}/?demo=1`);
    app.log.info(`db: ${DB_PATH}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
