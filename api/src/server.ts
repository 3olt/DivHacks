// Entry point: `npm run dev -w api` (watch) or `npm run start -w api`.
// Port: API_PORT, else PORT, else 4000. Host: API_HOST, else 0.0.0.0.
// Mode (API_MODE):
//   mongo     serve the Phase 4 collections in MongoDB Atlas (MONGODB_URI); exit 1 if it is unreachable
//   fixtures  serve the in-memory demo fixtures (no keys needed)
//   (unset)   mongo when MONGODB_URI is set and reachable at startup, else fixtures with a loud warning
// Other settings (root .env): EVENTS_TOKEN (POST /events/payment header x-events-token), SUBSCRIBERS_TOKEN (GET /subscribers
// header x-api-token; opt-in), DEV_ROUTES=1 (POST /dev/flip in mongo mode), DEMO_NO_SPAWN=1 (real demo runs require
// externally started xrpl services), PYTHON_BIN (python for data/*.py), API_SELF_URL (where demo runs post events),
// ALLOWED_ORIGINS (comma-separated extra browser origins for POST /demo/* and /dev/* in mongo mode; loopback always ok),
// DEMO_ALLOW_REMOTE=1 (mongo mode: allow POST /demo/* and /dev/* from non-loopback clients), RUN_LOCK_MAX_MS.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { AUTO_LIMIT, DAILY_CAP } from "./fixtures/wallets";
import { scrub } from "./lib/python";
import { MongoStore } from "./mongoStore";
import { FixtureStore, type DataStore } from "./store";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo-root .env (gitignored). Existing environment variables win.
config({ path: path.resolve(here, "../../.env"), quiet: true });

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";
const truthy = (v: string | undefined) => !!v && /^(1|true|yes)$/i.test(v);
const requested = (process.env.API_MODE ?? "").trim().toLowerCase();
if (requested && requested !== "mongo" && requested !== "fixtures") {
  console.error(`API_MODE must be "mongo" or "fixtures" (got "${requested}")`);
  process.exit(1);
}

const banner = (lines: string[]) => console.warn(["", "!".repeat(96), ...lines.map((l) => `!!  ${l}`), "!".repeat(96), ""].join("\n"));

async function chooseStore(): Promise<DataStore> {
  if (requested === "fixtures") return new FixtureStore();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    if (requested === "mongo") throw new Error("API_MODE=mongo but MONGODB_URI is not set (root .env)");
    banner(["FIXTURE MODE: MONGODB_URI is not set, so the API serves the in-memory DEMO fixtures (fictional data).", "Set MONGODB_URI in the root .env (or API_MODE=fixtures to silence this)."]);
    return new FixtureStore();
  }
  try {
    return await MongoStore.connect({ uri, dbName: process.env.MONGODB_DB ?? "divhacks", timeoutMs: Number(process.env.MONGO_CONNECT_TIMEOUT_MS ?? 8000) });
  } catch (e) {
    if (requested === "mongo") throw new Error(`API_MODE=mongo but MongoDB is unreachable: ${scrub((e as Error).message)}`);
    banner([
      "FIXTURE MODE (FALLBACK): MongoDB was NOT reachable at startup, so the API serves the in-memory DEMO fixtures.",
      `reason: ${scrub((e as Error).message).slice(0, 160)}`,
      "The map shows fictional data. Fix the connection and restart (API_MODE=mongo makes this fatal).",
    ]);
    return new FixtureStore();
  }
}

let store: DataStore;
try {
  store = await chooseStore();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const selfUrl = (process.env.API_SELF_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const app = await buildApp({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  store,
  demo: { apiUrl: selfUrl, noSpawn: truthy(process.env.DEMO_NO_SPAWN) },
  eventsToken: process.env.EVENTS_TOKEN,
  subscribersToken: process.env.SUBSCRIBERS_TOKEN,
  devRoutes: truthy(process.env.DEV_ROUTES),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(","),
  allowRemoteDemo: truthy(process.env.DEMO_ALLOW_REMOTE),
});

try {
  await app.listen({ port, host });
  app.log.info(`api (${store.mode} mode) listening on http://localhost:${port}  |  WS ws://localhost:${port}/live`);
  app.log.info(
    `POST /events/payment ${process.env.EVENTS_TOKEN ? "requires x-events-token" : "is OPEN (set EVENTS_TOKEN)"}; GET /subscribers ${process.env.SUBSCRIBERS_TOKEN ? "requires x-api-token" : "is open (SUBSCRIBERS_TOKEN unset)"}`,
  );
  if (store instanceof MongoStore) {
    const d = await store.describe();
    app.log.info(`mongo: ${d.real_sites} real sites + ${d.demo_sites} demo sites, ${d.decisions} decisions, golden ${d.golden_site ?? "(no demo_state)"}; real demo runs ${truthy(process.env.DEMO_NO_SPAWN) ? "require running xrpl services (DEMO_NO_SPAWN=1)" : "auto-spawn missing xrpl services"}; events -> ${selfUrl}`);
    if (d.missing_demo_sites.length) app.log.warn(`demo sites missing in Mongo: ${d.missing_demo_sites.join(", ")}: run "npm run seed:demo-sites -w api" so every demo scenario lands on a pin`);
    if (process.env.DEV_ROUTES && truthy(process.env.DEV_ROUTES)) app.log.warn("DEV_ROUTES=1: POST /dev/flip can overwrite real sites' scores (POST /dev/reset re-scores them)");
    app.log.info(
      `POST /demo/* and /dev/*: ${truthy(process.env.DEMO_ALLOW_REMOTE) ? "any client address (DEMO_ALLOW_REMOTE=1)" : "this machine only"}; browser origins: loopback${process.env.ALLOWED_ORIGINS ? ` + ALLOWED_ORIGINS` : ""}`,
    );
  } else {
    // Fixtures use fixed guardrails (reproducible hashes); flag it if the env the xrpl services use disagrees.
    for (const [k, v] of [["AUTO_LIMIT", AUTO_LIMIT], ["DAILY_CAP", DAILY_CAP]] as const) {
      if (process.env[k] !== undefined && Number(process.env[k]) !== v) {
        app.log.warn(`${k}=${process.env[k]} in env but the fixtures use ${v} (api/src/fixtures/wallets.ts); fixture checks will not match the co-signer`);
      }
    }
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
