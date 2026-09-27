// iMessage service built on Photon Spectrum (https://photon.codes/docs/spectrum-ts/introduction).
// - GET  /health                  -> { mode: "live" | "dry-run" }
// - Inbound iMessages: "STOP" unsubscribes; anything else is answered by Grok from the money trail (see replies.ts).
// - "Funded ✅" alerts: texts a site's followers when it turns green (see fundedAlerts.ts).
// Without SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET it runs in dry-run mode and only logs.
import { createServer, type ServerResponse } from "node:http";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { startFundedAlerts } from "./fundedAlerts";
import { replyTo } from "./replies";

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
    try {
      const answer = await replyTo(message.sender?.id ?? "", message.content.text);
      await space.send(answer);
    } catch (err) {
      // One failed reply must not stop the loop.
      console.error("reply failed", err);
    }
  }
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
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Internal error" });
  }
  // Localhost only: this service holds the Photon line, so nothing on the network should reach it.
}).listen(PORT, "127.0.0.1", () => console.log(`imessage service on 127.0.0.1:${PORT} (${live ? "live" : "dry-run"})`));

replyLoop().catch((err) => console.error("reply loop stopped", err));
startFundedAlerts(sendIMessage);
