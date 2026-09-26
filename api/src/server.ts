// Entry point: `npm run dev -w api` (watch) or `npm run start -w api`.
// Port: API_PORT, else PORT, else 4000. Host: API_HOST, else 0.0.0.0.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo-root .env (gitignored). Existing environment variables win.
config({ path: path.resolve(here, "../../.env"), quiet: true });

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const host = process.env.API_HOST ?? "0.0.0.0";

const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

try {
  await app.listen({ port, host });
  app.log.info(`api (fixture mode) listening on http://localhost:${port}  |  WS ws://localhost:${port}/live`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
