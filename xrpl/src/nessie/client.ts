// Capital One Nessie (sandbox bank API) as the nonprofit's "bank" for onboarding: name + address match on the account
// holder, and a two-amount micro-deposit. Behind the BankProvider interface so it can be stubbed (StubBank) if Nessie is down.
//
// Nessie facts (xrpl/scripts/risk/README-services.md): HTTPS only (https://api.nessieisreal.com), key as ?key= on every
// request (NESSIE_API_KEY, root .env; never logged: errors mask it), POST returns {code, message, objectCreated:{..., _id}},
// customers cannot be deleted (so one customer per EIN is reused: last_name "EIN 00-0000001"), deposit amounts are
// integers. Nessie's /enterprise endpoints expose every user's data, so ONLY public organization data goes in (legal
// name + public street address), never a person. Ids returned here go into the Mongo onboarding record only.
export interface BankOrg {
  ein: string;
  /** Legal/public name of the organization. */
  name: string;
  /** Public street address, "30 W Burnside Ave, Bronx, NY 10453". */
  address: string;
}
export interface BankAccountRef {
  customer_id: string;
  account_id: string;
  created: { customer: boolean; account: boolean };
}
export interface BankHolder {
  name: string;
  address: string;
}
export interface BankDeposit {
  deposit_id: string;
  amount: number;
  description: string;
  status: string;
}
export interface BankProvider {
  readonly kind: "nessie" | "stub";
  /** Finds (or creates) the organization's customer (one per EIN) and its Checking account. */
  findOrCreateAccount(org: BankOrg): Promise<BankAccountRef>;
  /** The account holder as the bank reports it (GET /accounts/{id}/customer). */
  accountHolder(accountId: string): Promise<BankHolder>;
  deposit(accountId: string, amount: number, description: string): Promise<{ deposit_id: string }>;
  listDeposits(accountId: string): Promise<BankDeposit[]>;
}

export const ACCOUNT_NICKNAME = "GlassLedger payee account (demo)";

export interface UsAddress {
  street_number: string;
  street_name: string;
  city: string;
  state: string;
  zip: string;
}

/** "30 W Burnside Ave, Bronx, NY 10453" -> {street_number "30", street_name "W Burnside Ave", city "Bronx", state "NY", zip "10453"}. */
export function parseUsAddress(a: string): UsAddress {
  const m = /^\s*(\d+[A-Za-z-]*)\s+(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/.exec(a);
  if (!m) throw new Error(`address ${JSON.stringify(a)} is not "<number> <street>, <city>, <ST> <zip>"`);
  return { street_number: m[1], street_name: m[2], city: m[3], state: m[4].toUpperCase(), zip: m[5] };
}

export const formatUsAddress = (a: Partial<UsAddress>) => `${a.street_number ?? ""} ${a.street_name ?? ""}, ${a.city ?? ""}, ${a.state ?? ""} ${a.zip ?? ""}`;

/** Case, punctuation and spacing insensitive form for comparing names/addresses. */
export const normalizeForMatch = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const maskKey = (s: string) => s.replace(/([?&]key=)[^&\s"']+/g, "$1***");

type NessieCustomer = { _id: string; first_name?: string; last_name?: string; address?: Partial<UsAddress> };
type NessieAccount = { _id: string; type?: string; nickname?: string; customer_id?: string };
type NessieDeposit = { _id: string; amount?: number; description?: string; status?: string };

export class NessieBank implements BankProvider {
  readonly kind = "nessie" as const;
  private base: string;
  constructor(private key: string, base = "https://api.nessieisreal.com") {
    if (!key) throw new Error("NESSIE_API_KEY missing from the root .env");
    const u = new URL(base);
    if (u.protocol !== "https:") throw new Error(`Nessie base ${base} must be https:// (plain HTTP is not served)`);
    this.base = base.replace(/\/$/, "");
  }

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; json: T }> {
    const url = `${this.base}${p}${p.includes("?") ? "&" : "?"}key=${encodeURIComponent(this.key)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`Nessie ${method} ${p} failed: ${maskKey((e as Error).message)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (res.status >= 400) throw new Error(`Nessie ${method} ${p} -> HTTP ${res.status}: ${maskKey(text.slice(0, 200))}`);
    return { status: res.status, json: json as T };
  }

  private static createdId(json: unknown): string | null {
    const id = (json as { objectCreated?: { _id?: unknown } } | null)?.objectCreated?._id;
    return typeof id === "string" && id ? id : null;
  }

  async findOrCreateAccount(org: BankOrg): Promise<BankAccountRef> {
    const lastName = `EIN ${org.ein}`;
    const created = { customer: false, account: false };
    const find = async () => (await this.call<NessieCustomer[]>("GET", "/customers")).json.filter((c) => c.last_name === lastName).sort((a, b) => (a._id < b._id ? -1 : 1))[0];
    let cust = await find();
    if (!cust) {
      const r = await this.call("POST", "/customers", { first_name: org.name, last_name: lastName, address: parseUsAddress(org.address) });
      const id = NessieBank.createdId(r.json);
      cust = id ? { _id: id } : await find();
      if (!cust) throw new Error("Nessie created the customer but it cannot be found again");
      created.customer = true;
    }
    const findAcct = async () => (await this.call<NessieAccount[]>("GET", `/customers/${encodeURIComponent(cust!._id)}/accounts`)).json.find((a) => a.type === "Checking" && a.nickname === ACCOUNT_NICKNAME);
    let acct = await findAcct();
    if (!acct) {
      const r = await this.call("POST", `/customers/${encodeURIComponent(cust._id)}/accounts`, { type: "Checking", nickname: ACCOUNT_NICKNAME, rewards: 0, balance: 0 });
      const id = NessieBank.createdId(r.json);
      acct = id ? { _id: id } : await findAcct();
      if (!acct) throw new Error("Nessie created the account but it cannot be found again");
      created.account = true;
    }
    return { customer_id: cust._id, account_id: acct._id, created };
  }

  async accountHolder(accountId: string): Promise<BankHolder> {
    const c = (await this.call<NessieCustomer>("GET", `/accounts/${encodeURIComponent(accountId)}/customer`)).json;
    return { name: String(c?.first_name ?? ""), address: formatUsAddress(c?.address ?? {}) };
  }

  async deposit(accountId: string, amount: number, description: string): Promise<{ deposit_id: string }> {
    if (!Number.isInteger(amount) || amount < 1) throw new Error("Nessie deposit amounts are positive integers");
    const r = await this.call("POST", `/accounts/${encodeURIComponent(accountId)}/deposits`, {
      medium: "balance", transaction_date: new Date().toISOString().slice(0, 10), status: "completed", amount, description,
    });
    const id = NessieBank.createdId(r.json);
    if (!id) throw new Error("Nessie accepted the deposit but returned no id");
    return { deposit_id: id };
  }

  async listDeposits(accountId: string): Promise<BankDeposit[]> {
    const r = await this.call<NessieDeposit[]>("GET", `/accounts/${encodeURIComponent(accountId)}/deposits`);
    return (Array.isArray(r.json) ? r.json : []).map((d) => ({ deposit_id: d._id, amount: Number(d.amount), description: String(d.description ?? ""), status: String(d.status ?? "") }));
  }
}

/** FALLBACK ONLY (NESSIE_STUB=1 or Nessie unreachable): an in-memory bank with the same interface. Clearly labelled
 *  "stub" in the onboarding record and output; nothing it says is a real bank response. */
export class StubBank implements BankProvider {
  readonly kind = "stub" as const;
  private accounts = new Map<string, { org: BankOrg; deposits: BankDeposit[] }>();
  async findOrCreateAccount(org: BankOrg): Promise<BankAccountRef> {
    const id = `stub-${org.ein}`;
    const created = !this.accounts.has(id);
    if (created) this.accounts.set(id, { org, deposits: [] });
    return { customer_id: `stub-customer-${org.ein}`, account_id: id, created: { customer: created, account: created } };
  }
  async accountHolder(accountId: string): Promise<BankHolder> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("stub account not found");
    return { name: a.org.name, address: formatUsAddress(parseUsAddress(a.org.address)) };
  }
  async deposit(accountId: string, amount: number, description: string): Promise<{ deposit_id: string }> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("stub account not found");
    const d = { deposit_id: `stub-dep-${a.deposits.length + 1}`, amount, description, status: "completed" };
    a.deposits.push(d);
    return { deposit_id: d.deposit_id };
  }
  async listDeposits(accountId: string): Promise<BankDeposit[]> {
    return [...(this.accounts.get(accountId)?.deposits ?? [])];
  }
}

/** Nessie unless NESSIE_STUB=1. */
export function bankFromEnv(): BankProvider {
  if (/^(1|true|yes)$/i.test(process.env.NESSIE_STUB ?? "")) return new StubBank();
  return new NessieBank(process.env.NESSIE_API_KEY ?? "", process.env.NESSIE_BASE_URL || "https://api.nessieisreal.com");
}
