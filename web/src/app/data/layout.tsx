import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Open data · GlassLedger",
  description: "Every record behind the GlassLedger map, plus the payment agent's real XRPL Testnet activity: searchable, sortable, downloadable.",
};

export default function OpenDataLayout({ children }: LayoutProps<"/data">) {
  return children;
}
