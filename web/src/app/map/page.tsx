import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = { title: "Map · GlassLedger" };

export default function MapPage() {
  return <Dashboard />;
}
