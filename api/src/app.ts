import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppContext } from "./context";
import { fixtureScenarioRunner, type ScenarioRunner } from "./demo/scenarios";
import { LiveHub } from "./live";
import { registerAgencyRoutes } from "./routes/agencies";
import { registerDecisionRoutes } from "./routes/decisions";
import { registerDemoRoutes } from "./routes/demo";
import { registerDevRoutes } from "./routes/dev";
import { registerEventRoutes } from "./routes/events";
import { registerHealthRoutes } from "./routes/health";
import { registerLiveRoutes } from "./routes/live";
import { registerSiteRoutes } from "./routes/sites";
import { registerSubscriberRoutes } from "./routes/subscribers";
import { registerXrplRoutes } from "./routes/xrpl";
import { FixtureStore, type DataStore } from "./store";

export const API_VERSION = "0.1.0";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  store?: DataStore;
  runScenario?: ScenarioRunner;
  heartbeatMs?: number;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const store = opts.store ?? new FixtureStore();
  const hub = new LiveHub(store.mode, opts.heartbeatMs ?? 25_000);
  const ctx: AppContext = { store, hub, runScenario: opts.runScenario ?? fixtureScenarioRunner(store), version: API_VERSION };

  // JSON parser that tolerates an empty body (e.g. fetch(url, {method:"POST", headers:{"content-type":"application/json"}})).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body ?? "").trim();
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("Request body is not valid JSON") as FastifyError;
      err.statusCode = 400;
      (err as { code: string }).code = "invalid_json";
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    const error =
      err.code === "invalid_json"
        ? "invalid_json"
        : status === 415
          ? "unsupported_media_type"
          : status === 413
            ? "payload_too_large"
            : status >= 500
              ? "internal_error"
              : "bad_request";
    return reply.code(status).send({ error, message: status >= 500 ? "Internal server error" : err.message });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", message: `No route for ${req.method} ${req.url.split("?")[0]}` }),
  );

  await app.register(cors, { origin: true, methods: ["GET", "POST", "DELETE", "OPTIONS"] });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  registerHealthRoutes(app, ctx);
  registerSiteRoutes(app, ctx);
  registerAgencyRoutes(app, ctx);
  registerDecisionRoutes(app, ctx);
  registerSubscriberRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerDemoRoutes(app, ctx);
  registerDevRoutes(app, ctx);
  registerXrplRoutes(app, ctx);
  registerLiveRoutes(app, ctx);

  app.addHook("onClose", async () => hub.close());
  return app;
}
