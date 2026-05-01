import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import { registerRoutes } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.AGENTGATE_DB ?? resolve(__dirname, "../data/agentgate.db");
const PUBLIC_DIR = resolve(__dirname, "../public");

async function main() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const db = openDb(DB_PATH);

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/" });
  registerRoutes(app, db);

  app.addHook("onClose", async () => {
    db.close();
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`agentgate control plane listening on http://${HOST}:${PORT}`);
    app.log.info(`db: ${DB_PATH}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
