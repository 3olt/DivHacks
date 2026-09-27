import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppContext } from "./context";
import { RealDemoRunner } from "./demo/realRunner";
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
import { sendError } from "./lib/http";
import { FixtureStore, type DataStore } from "./store";

export const API_VERSION = "0.1.0";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  store?: DataStore;
  runScenario?: ScenarioRunner;
  heartbeatMs?: number;
  /** Mongo mode: the real XRPL Testnet demo runner's settings (ignored in fixture mode). */
  demo?: { apiUrl: string; noSpawn?: boolean };
  eventsToken?: string;
  subscribersToken?: string;
  devRoutes?: boolean;
  /** Mongo mode: extra browser origins allowed to POST /demo/* and /dev/* (loopback origins are always allowed). */
  allowedOrigins?: string[];
  /** Mongo mode: allow POST /demo/* and /dev/* from a non-loopback client (DEMO_ALLOW_REMOTE=1). Default false. */
  allowRemoteDemo?: boolean;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const isLoopbackIp = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });
  const store: DataStore = opts.store ?? new FixtureStore();
  const hub = new LiveHub(store.mode, opts.heartbeatMs ?? 25_000);
  const demoRunner =
    store.mode === "mongo"
      ? new RealDemoRunner({
          apiUrl: opts.demo?.apiUrl ?? "http://localhost:4000",
          noSpawn: opts.demo?.noSpawn,
          eventsToken: opts.eventsToken,
          onStatus: (r) => hub.broadcast({ type: "demo_run", run_id: r.run_id, scenario: r.scenario, status: r.status }),
          log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) },
        })
      : null;
  const ctx: AppContext = {
    store,
    hub,
    runScenario: opts.runScenario ?? fixtureScenarioRunner(store),
    demoRunner,
    eventsToken: opts.eventsToken || undefined,
    subscribersToken: opts.subscribersToken || undefined,
    devRoutes: opts.devRoutes ?? false,
    version: API_VERSION,
  };

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

  // Mongo mode: POST /demo/* starts a REAL Testnet run (it spends RLUSD and the rolling caps) and POST /dev/* rewrites
  // scores, so only this machine may call them: a browser page from another origin (CSRF: a no-body POST needs no
  // preflight) gets 403 origin_not_allowed, and a client on the LAN gets 403 remote_not_allowed. Loopback origins
  // (http://localhost:<any port>, 127.0.0.1, [::1]) plus ALLOWED_ORIGINS pass; server-side callers send no Origin.
  // Reads (GET) stay open to any origin. DEMO_ALLOW_REMOTE=1 lifts the client-address rule (e.g. a demo from a 2nd laptop).
  if (store.mode === "mongo") {
    const extra = new Set((opts.allowedOrigins ?? []).map((o) => o.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean));
    app.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      const p = req.url.split("?")[0];
      if (!p.startsWith("/demo/") && !p.startsWith("/dev/")) return;
      const origin = req.headers.origin;
      if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin) && !extra.has(origin.toLowerCase())) {
        return sendError(reply, 403, "origin_not_allowed", `POST ${p} is only allowed from this machine's web app (origin ${origin} is not allowed; add it to ALLOWED_ORIGINS)`);
      }
      if (!opts.allowRemoteDemo && !isLoopbackIp(req.ip)) {
        return sendError(reply, 403, "remote_not_allowed", `POST ${p} is only allowed from this machine in mongo mode (demo runs make real XRPL Testnet payments; dev routes rewrite scores); set DEMO_ALLOW_REMOTE=1 to allow other clients`);
      }
    });
  }
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

  app.addHook("onClose", async () => {
    hub.close();
    const active = demoRunner?.active;
    if (active) app.log.warn(`demo run ${active.run_id} (${active.scenario}) is still running; it finishes on its own (never killed: a kill switch run must restore)`);
    await store.close?.();
  });
  return app;
}
