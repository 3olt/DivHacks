// Independent verifier helpers: raw JSON-RPC against the public XRPL Testnet (no xrpl.js, no _lib.ts),
// so the claims made by the risk-check scripts are checked through a different code path.
export const RPC = "https://s.altnet.rippletest.net:51234";
if (!/altnet|testnet|devnet/.test(RPC)) throw new Error("verifier must only talk to a test network");

export async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: [params] }),
      });
      const body = (await res.json()) as { result: T };
      return body.result;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export const hexToUtf8 = (h?: string) => (h ? Buffer.from(h, "hex").toString("utf8") : undefined);
export const drops = (a: unknown) => (typeof a === "string" ? `${Number(a) / 1e6} XRP` : a);
