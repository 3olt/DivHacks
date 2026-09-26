// Placeholder for iMessage sign-up. Photon (Spectrum) integration goes here.
const subscribers: { phone: string; site_id: string | null }[] = [];

export async function POST(req: Request) {
  const { phone, site_id } = (await req.json()) as { phone?: string; site_id?: string };
  if (!phone) return Response.json({ error: "Phone number required" }, { status: 400 });
  subscribers.push({ phone, site_id: site_id ?? null });
  return Response.json({ ok: true, photon_connected: false }, { status: 201 });
}
