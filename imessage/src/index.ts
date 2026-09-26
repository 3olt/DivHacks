// iMessage service built on Photon Spectrum (https://photon.codes/docs/spectrum-ts/introduction).
// - POST /notify { phone, text }  -> sends an iMessage (called by the web app)
// - GET  /health                  -> { mode: "live" | "dry-run" }
// - Inbound iMessages get a placeholder reply (money-trail Q&A goes here later).
// - "Funded ✅" alerts: texts a site's followers when it turns green (see fundedAlerts.ts).
// Without SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET it runs in dry-run mode and only logs.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startFundedAlerts } from "./fundedAlerts";

const PORT = Number(process.env.PORT ?? 4003);
const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
const live = Boolean(projectId && projectSecret);

const app = live
  ? await Spectrum({ projectId: projectId!, projectSecret: projectSecret!, providers: [imessage.config()] })
  : null;

async function sendIMessage(phone: string, text: string): Promise<void> {
  if (!app) {
    console.log(`[dry-run] to ${phone}: ${text}`);
    return;
  }
  const space = await imessage(app).space.create(phone);
  await space.send(text);
}

async function replyLoop(): Promise<void> {
  if (!app) return;
  for await (const [space, message] of imessage(app).messages) {
    if (message.content.type !== "text") continue;
    console.log(`[inbound] ${message.sender?.id ?? "unknown"}: ${message.content.text}`);
    // TODO: answer "why?" with the money trail for the user's subscribed sites (GET web /api/sites/[id]).
    try {
      await space.send("Thanks! Money-trail answers are coming soon. You'll get alerts for your saved locations here.");
    } catch (err) {
      // One failed reply must not stop the loop.
      console.error("reply failed", err);
    }
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { mode: live ? "live" : "dry-run" });
    }
    if (req.method === "POST" && req.url === "/notify") {
      const { phone, text } = await readJson(req);
      if (typeof phone !== "string" || typeof text !== "string" || !/^\+\d{10,15}$/.test(phone)) {
        return json(res, 400, { error: "Expected { phone: E.164 string, text: string }" });
      }
      await sendIMessage(phone, text);
      return json(res, 200, { ok: true, mode: live ? "live" : "dry-run" });
    }
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    // Free plan: only numbers added under Users in the Photon dashboard can be messaged.
    if (String(err).includes("Target not allowed")) return json(res, 403, { error: "not_allowed" });
    json(res, 500, { error: "Send failed" });
  }
}).listen(PORT, () => console.log(`imessage service on :${PORT} (${live ? "live" : "dry-run"})`));

replyLoop().catch((err) => console.error("reply loop stopped", err));
startFundedAlerts(sendIMessage);
