#!/usr/bin/env node
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerDemoRoutes } from "./routes-demo.js";
import { seedDemoPolicies } from "./demo/seed.js";
import { loadAuthConfig, isLoopbackHost } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "4000", 10);
// Loopback by default. Binding a non-loopback interface exposes the control
// plane to the network, so it is only allowed once auth tokens are configured
// (enforced below). Previously this defaulted to 0.0.0.0 with no auth.
const HOST = process.env.HOST ?? "127.0.0.1";
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

  const auth = loadAuthConfig();

  // Refuse to expose an unauthenticated control plane to the network. Without
  // tokens, anyone who can reach the port could approve actions; loopback keeps
  // that surface on the local machine only.
  if (!auth.configured && !isLoopbackHost(HOST)) {
    app.log.error(
      `refusing to bind non-loopback host ${HOST} without authentication. ` +
        `Set AGENTGATE_TOKEN (and friends) to enable team mode, or bind 127.0.0.1.`,
    );
    process.exit(1);
  }

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });
  registerRoutes(app, db, auth);
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
    if (auth.configured) {
      app.log.info(`auth: TEAM MODE — ${auth.tokens.size} token(s); bearer required on /v1`);
    } else {
      app.log.warn(
        `auth: DEV MODE — no tokens configured, loopback only. ` +
          `Decisions are stamped '${auth.devActor}'. Set AGENTGATE_TOKEN for team mode.`,
      );
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
