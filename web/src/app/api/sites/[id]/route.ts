import type { NextRequest } from "next/server";
import { getSiteDetail } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/sites/[id]">) {
  const { id } = await ctx.params;
  const detail = getSiteDetail(id);
  if (!detail) return Response.json({ error: "Site not found" }, { status: 404 });
  return Response.json(detail);
}
