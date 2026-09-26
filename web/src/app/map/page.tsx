import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = { title: "Map · NYC Money Map" };

export default function MapPage() {
  return <Dashboard />;
}
