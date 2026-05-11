import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { runScenario, SCENARIOS, type ScenarioId } from "./demo/scenarios.js";
import { resetDemoState, seedDemoPolicies } from "./demo/seed.js";

// Track in-flight runs so the dashboard can show "running" state and we can
// avoid spawning duplicates if the user double-clicks.
const inFlight = new Map<ScenarioId, Promise<unknown>>();
const lastResult = new Map<ScenarioId, { ts: string; status: string; message: string }>();

function isScenarioId(s: string): s is ScenarioId {
  return SCENARIOS.some((sc) => sc.id === s);
}

export function registerDemoRoutes(
  app: FastifyInstance,
  db: Database.Database,
  baseUrl: string,
): void {
  app.get("/v1/demo/scenarios", async () => {
    return SCENARIOS.map((s) => ({
      id: s.id,
      agent: s.agent,
      title: s.title,
      pitch: s.pitch,
      outcomeHint: s.outcomeHint,
      expectedEffect: s.expectedEffect,
      emoji: s.emoji,
      running: inFlight.has(s.id),
      lastResult: lastResult.get(s.id) ?? null,
    }));
  });

  app.post<{ Params: { id: string } }>(
    "/v1/demo/run/:id",
    async (req, reply) => {
      const id = req.params.id;
      if (!isScenarioId(id)) {
        return reply.code(404).send({ error: `unknown scenario ${id}` });
      }
      if (inFlight.has(id)) {
        return reply.code(409).send({ error: "already running", scenarioId: id });
      }
      const promise = runScenario(id, { baseUrl })
        .then((res) => {
          lastResult.set(id, {
            ts: new Date().toISOString(),
            status: res.status,
            message: res.message,
          });
          return res;
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          lastResult.set(id, {
            ts: new Date().toISOString(),
            status: "error",
            message: msg,
          });
        })
        .finally(() => {
          inFlight.delete(id);
        });
      inFlight.set(id, promise);
      return reply.code(202).send({ started: true, scenarioId: id });
    },
  );

  app.post("/v1/demo/run-all", async (_req, reply) => {
    const started: ScenarioId[] = [];
    for (const sc of SCENARIOS) {
      if (inFlight.has(sc.id)) continue;
      const p = runScenario(sc.id, { baseUrl })
        .then((res) => {
          lastResult.set(sc.id, {
            ts: new Date().toISOString(),
            status: res.status,
            message: res.message,
          });
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          lastResult.set(sc.id, {
            ts: new Date().toISOString(),
            status: "error",
            message: msg,
          });
        })
        .finally(() => {
          inFlight.delete(sc.id);
        });
      inFlight.set(sc.id, p);
      started.push(sc.id);
    }
    return reply.code(202).send({ started });
  });

  app.post("/v1/demo/reset", async () => {
    const result = resetDemoState(db);
    inFlight.clear();
    lastResult.clear();
    return result;
  });

  app.post("/v1/demo/seed", async () => {
    return seedDemoPolicies(db);
  });
}
