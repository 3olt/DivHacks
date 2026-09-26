// Entry point: `npm run dev -w api` (watch) or `npm run start -w api`.
// Port: API_PORT, else PORT, else 4000. Host: API_HOST, else 0.0.0.0.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { AUTO_LIMIT, DAILY_CAP } from "./fixtures/wallets";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo-root .env (gitignored). Existing environment variables win.
config({ path: path.resolve(here, "../../.env"), quiet: true });

// Fixtures use fixed guardrails (reproducible hashes); flag it if the env the xrpl services use disagrees.
const envMismatch = ([["AUTO_LIMIT", AUTO_LIMIT], ["DAILY_CAP", DAILY_CAP]] as const).filter(
  ([k, v]) => process.env[k] !== undefined && Number(process.env[k]) !== v,
);

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

try {
  await app.listen({ port, host });
  app.log.info(`api (fixture mode) listening on http://localhost:${port}  |  WS ws://localhost:${port}/live`);
  for (const [k, v] of envMismatch) {
    app.log.warn(`${k}=${process.env[k]} in env but the fixtures use ${v} (api/src/fixtures/wallets.ts); fixture checks will not match the co-signer`);
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
