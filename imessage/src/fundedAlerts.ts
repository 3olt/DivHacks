// "Funded ✅" alerts: listens to the API's WebSocket /live and, when a site turns green,
// texts everyone following it (GET /subscribers?site_id=). See docs/API.md.
const API_URL = process.env.API_URL || "http://localhost:4000";

type Risk = { level: "green" | "yellow" | "red"; summary: string };
type Site = { id: string; name: string; risk: Risk };
type Subscriber = { phone: string };
type LiveMessage = { type: "hello" } | { type: "site_updated"; site_id: string; risk: Risk } | { type: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function startFundedAlerts(send: (phone: string, text: string) => Promise<void>): void {
  // Last known level per site, so only a change *to* green triggers an alert.
  const levels = new Map<string, Risk["level"]>();
  let retry = 0;

  async function resync() {
    try {
      for (const s of await getJson<Site[]>("/sites")) levels.set(s.id, s.risk.level);
    } catch (err) {
      console.error("[funded-alerts] resync failed", err);
    }
  }

  async function onSiteUpdated(siteId: string, risk: Risk) {
    const previous = levels.get(siteId);
    levels.set(siteId, risk.level);
    if (risk.level !== "green" || previous === "green") return;

    const [site, followers] = await Promise.all([
      getJson<Site>(`/sites/${encodeURIComponent(siteId)}`),
      getJson<Subscriber[]>(`/subscribers?site_id=${encodeURIComponent(siteId)}`),
    ]);
    const text = `✅ ${site.name} is financially stable again. ${risk.summary}`;
    console.log(`[funded-alerts] ${site.name} turned green; texting ${followers.length} follower(s)`);
    for (const f of followers) {
      try {
        await send(f.phone, text);
      } catch (err) {
        // e.g. a number not on the Photon project's Users list (free plan). Skip it and keep going.
        console.error(`[funded-alerts] could not text ${f.phone}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  function connect() {
    const ws = new WebSocket(API_URL.replace(/^http/, "ws") + "/live");
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello") void resync();
      else if (msg.type === "site_updated" && "site_id" in msg) {
        onSiteUpdated(msg.site_id, msg.risk).catch((err) => console.error("[funded-alerts]", err));
      }
    };
    ws.onclose = () => {
      setTimeout(connect, Math.min(30_000, 1_000 * 2 ** retry++));
    };
    ws.onerror = () => {
      // onclose follows and reconnects
    };
  }

  connect();
  console.log(`[funded-alerts] watching ${API_URL}/live`);
}
