import type { Metadata } from "next";
import DemoPage from "@/components/demo/DemoPage";

export const metadata: Metadata = { title: "Live demo · GlassLedger" };

export default function Demo() {
  return <DemoPage />;
}
