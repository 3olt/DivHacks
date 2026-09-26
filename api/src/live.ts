// WebSocket hub for /live. Sends {type:"hello"} on connect, broadcasts LiveMessages to every client,
// and pings every client every 25s (protocol-level ping; browsers answer automatically). Clients that
// miss a pong are terminated. Messages from clients are ignored.
import type { WebSocket } from "ws";
import type { LiveMessage } from "../../shared/contracts";
import { nowNY } from "./lib/time";
import type { StoreMode } from "./store";

export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly mode: StoreMode,
    private readonly heartbeatMs = 25_000,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    this.clients.add(socket);
    this.alive.set(socket, true);
    socket.on("pong", () => this.alive.set(socket, true));
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    socket.on("message", () => {
      /* client -> server messages are ignored */
    });
    this.send(socket, { type: "hello", mode: this.mode, server_time: nowNY() });
    this.startHeartbeat();
  }

  /** Send to every open client. Returns how many clients it was sent to. */
  broadcast(msg: LiveMessage): number {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
        n++;
      }
    }
    return n;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.clients) socket.close(1001, "server shutting down");
    this.clients.clear();
  }

  private send(socket: WebSocket, msg: LiveMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const socket of this.clients) {
        if (this.alive.get(socket) === false) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        this.alive.set(socket, false);
        try {
          socket.ping();
        } catch {
          /* socket already closing */
        }
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }
}
