import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = { title: "Map · GlassLedger" };

// /map?site=<id> opens that location (used by the site report's "Open on the map").
export default async function MapPage(props: PageProps<"/map">) {
  const { site } = await props.searchParams;
  return <Dashboard initialSiteId={typeof site === "string" ? site : null} />;
}
