// WebSocket /live client (from docs/API.md): reconnects with backoff, passes known message types.
import type { LiveMessage } from "./contracts";
import { API_URL } from "./api";

export function connectLive(onMessage: (msg: LiveMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let stopped = false;
  const open = () => {
    ws = new WebSocket(API_URL.replace(/^http/, "ws") + "/live");
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "hello" || msg.type === "site_updated" || msg.type === "decision") onMessage(msg as LiveMessage);
    };
    ws.onclose = () => {
      if (!stopped) setTimeout(open, Math.min(30_000, 1_000 * 2 ** retry++));
    };
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}
