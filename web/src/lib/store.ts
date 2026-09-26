// In-memory store backed by mock data. Swap for MongoDB when the data pipeline is ready.
import { contracts, nonprofits, payments as seedPayments, sites as seedSites } from "./mockData";
import type { Payment, Site, SiteDetail } from "./types";

type Store = { sites: Site[]; payments: Payment[] };

// Keep state across dev hot reloads.
const g = globalThis as unknown as { __store?: Store };
const store: Store = (g.__store ??= {
  sites: structuredClone(seedSites),
  payments: structuredClone(seedPayments),
});

export function getSites(): Site[] {
  return store.sites;
}

export function getSiteDetail(id: string): SiteDetail | null {
  const site = store.sites.find((s) => s.id === id);
  if (!site) return null;
  return {
    site,
    nonprofit: nonprofits.find((n) => n.ein === site.nonprofit_ein) ?? null,
    contracts: contracts.filter((c) => c.payee_ein === site.nonprofit_ein),
    payments: store.payments.filter((p) => p.payee_ein === site.nonprofit_ein),
  };
}

export function getPayments(): Payment[] {
  return store.payments;
}

// Called by the XRPL agent after it acts. A released payment marks the payee's sites as funded.
export function recordPayment(payment: Payment): void {
  store.payments.push(payment);
  if (payment.status !== "released") return;
  for (const site of store.sites) {
    if (site.nonprofit_ein !== payment.payee_ein) continue;
    site.risk = {
      level: "green",
      score: 10,
      reasons: [`Payment ${payment.invoice_id} released on XRPL`],
    };
  }
}
