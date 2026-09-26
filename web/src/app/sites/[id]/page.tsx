import type { Metadata } from "next";
import SiteReport from "@/components/report/SiteReport";

export const metadata: Metadata = { title: "Site report · GlassLedger" };

export default async function SiteReportPage(props: PageProps<"/sites/[id]">) {
  const { id } = await props.params;
  return <SiteReport id={id} />;
}
