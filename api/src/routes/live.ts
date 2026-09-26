import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";

export function registerLiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.route({
    method: "GET",
    url: "/live",
    // Plain HTTP GET (no Upgrade header): explain instead of an empty 404.
    handler: async (_req, reply) =>
      reply.code(426).send({ error: "upgrade_required", message: "GET /live is a WebSocket endpoint: connect with new WebSocket('ws://<host>/live')" }),
    wsHandler: (socket) => {
      ctx.hub.add(socket);
    },
  });
}
