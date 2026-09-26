// Read-only XRP Ledger Testnet client for the open-data page (/data).
// Raw JSON over WebSocket (no xrpl.js), so the same code runs in the browser and in Node 22 (global WebSocket).
// Nothing in this file signs or submits a transaction: it only reads account_tx / account_info / account_lines
// and subscribes to an account stream.

export const XRPL_TESTNET_WS = "wss://s.altnet.rippletest.net:51233";
export const TESTNET_EXPLORER = "https://testnet.xrpl.org";
export const explorerTxUrl = (hash: string) => `${TESTNET_EXPLORER}/transactions/${hash}`;
export const explorerAccountUrl = (address: string) => `${TESTNET_EXPLORER}/accounts/${address}`;
/** AccountRoot flag: the master key is disabled (only the signer list can sign). */
export const LSF_DISABLE_MASTER = 0x00100000;
/** Memo type the payment agent writes (hex-decoded MemoType). */
export const PAYMENT_MEMO_TYPE = "divhacks/payment/v1";
const RIPPLE_EPOCH = 946684800;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// Registry (GET /xrpl/accounts = xrpl/data/accounts.testnet.json): public Testnet addresses and roles only
// ---------------------------------------------------------------------------

export interface Registry {
  network: string;
  rlusd: { issuer: string; currency: string };
  city_issuer: string;
  city_treasury: string;
  agent_account: string;
  signers: Record<string, { address: string; weight: number }>;
  quorum: number;
  nonprofits: Record<string, { address: string; ein: string; name: string; contract_id: string }>;
  attacker: string;
  source_tag: number;
}

export type RoleKind = "multisig_account" | "treasury" | "city_issuer" | "nonprofit" | "attacker" | "rlusd_issuer" | "signer_key";

export interface RoleInfo {
  /** Registry key: "agent_account", "city_treasury", "city_issuer", "np_1".."np_4", "attacker", "rlusd_issuer", "agent", "cosigner", "officer". */
  role: string;
  label: string;
  address: string;
  kind: RoleKind;
  weight?: number;
  ein?: string;
  name?: string;
  contract_id?: string;
}

/** Every role in the registry, in display order. */
export function registryRoles(reg: Registry): RoleInfo[] {
  const out: RoleInfo[] = [
    { role: "agent_account", label: "Agent account (multisig; holds the RLUSD working balance)", address: reg.agent_account, kind: "multisig_account" },
    { role: "city_treasury", label: "City treasury (funds the agent account)", address: reg.city_treasury, kind: "treasury" },
    { role: "city_issuer", label: "City issuer (nonprofit credentials, Phase 3)", address: reg.city_issuer, kind: "city_issuer" },
  ];
  for (const [key, np] of Object.entries(reg.nonprofits ?? {})) {
    out.push({ role: key, label: np.name, address: np.address, kind: "nonprofit", ein: np.ein, name: np.name, contract_id: np.contract_id });
  }
  out.push({ role: "attacker", label: "Attacker (red-team address; not on the allowlist)", address: reg.attacker, kind: "attacker" });
  out.push({ role: "rlusd_issuer", label: "RLUSD issuer (Ripple, Testnet)", address: reg.rlusd?.issuer, kind: "rlusd_issuer" });
  for (const [key, s] of Object.entries(reg.signers ?? {})) {
    out.push({ role: key, label: `${key} signing key (weight ${s.weight})`, address: s.address, kind: "signer_key", weight: s.weight });
  }
  return out.filter((r) => typeof r.address === "string" && r.address.length > 0);
}

/** address -> role. */
export function roleIndex(reg: Registry): Map<string, RoleInfo> {
  const m = new Map<string, RoleInfo>();
  for (const r of registryRoles(reg)) if (!m.has(r.address)) m.set(r.address, r);
  return m;
}

// ---------------------------------------------------------------------------
// Decoding helpers (pure)
// ---------------------------------------------------------------------------

export function hexToUtf8(hex: string): string {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8").decode(bytes);
}

/** "USD" stays "USD"; a 40-hex code decodes to its ASCII name ("524C5553440000..." -> "RLUSD"); anything else is returned as is. */
export function decodeCurrency(code: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(code)) return code;
  if (code.startsWith("00")) {
    // Standard currency in its 160-bit form: ISO code in bytes 12..14.
    const iso = hexToUtf8(code.slice(24, 30)).replace(/\0/g, "");
    return /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(iso) ? iso : code;
  }
  const text = hexToUtf8(code).replace(/\0+$/, "");
  return /^[\x20-\x7E]+$/.test(text) ? text : code;
}

/** "99999712" drops -> "99.999712" XRP (string math, no float rounding). */
export function dropsToXrp(drops: string): string {
  if (!/^-?\d+$/.test(drops)) return drops;
  const neg = drops.startsWith("-");
  const digits = drops.replace("-", "").padStart(7, "0");
  const int = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-6).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Ripple epoch seconds -> ISO 8601 (UTC). */
export function rippleTimeToIso(seconds: number): string {
  return new Date((seconds + RIPPLE_EPOCH) * 1000).toISOString();
}

export interface LedgerAmount {
  value: string;
  currency: string;
  issuer: string | null;
}

/** XRP drops string or {currency, issuer, value} -> decoded amount. */
export function parseAmount(a: unknown): LedgerAmount | null {
  if (typeof a === "string") return { value: dropsToXrp(a), currency: "XRP", issuer: null };
  if (isObj(a) && typeof a.value === "string" && typeof a.currency === "string") {
    return { value: a.value, currency: decodeCurrency(a.currency), issuer: str(a.issuer) };
  }
  return null;
}

export interface DecodedMemo {
  type: string | null;
  format: string | null;
  data: string | null;
}

/** tx.Memos[] with hex MemoType / MemoFormat / MemoData decoded to UTF-8. */
export function decodeMemos(tx: Json): DecodedMemo[] {
  return arr(tx.Memos).map((m) => {
    const memo = obj(obj(m).Memo);
    const dec = (k: string) => {
      const h = str(memo[k]);
      return h ? hexToUtf8(h) : null;
    };
    return { type: dec("MemoType"), format: dec("MemoFormat"), data: dec("MemoData") };
  });
}

/** The agent's on-ledger payment memo {inv, ctr, ein, dh, rv}. */
export interface PaymentMemo {
  inv: string;
  ctr: string;
  ein: string;
  dh: string;
  rv: string;
}

export function paymentMemoOf(memos: DecodedMemo[]): PaymentMemo | null {
  for (const m of memos) {
    if (!m.data) continue;
    if (m.type !== null && m.type !== PAYMENT_MEMO_TYPE) continue;
    try {
      const j: unknown = JSON.parse(m.data);
      if (isObj(j) && typeof j.inv === "string") {
        return { inv: String(j.inv), ctr: String(j.ctr ?? ""), ein: String(j.ein ?? ""), dh: String(j.dh ?? ""), rv: String(j.rv ?? "") };
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

const ACCOUNT_SET_FLAGS: Record<number, string> = {
  1: "asfRequireDest",
  2: "asfRequireAuth",
  3: "asfDisallowXRP",
  4: "asfDisableMaster (disable the master key)",
  5: "asfAccountTxnID",
  6: "asfNoFreeze",
  7: "asfGlobalFreeze",
  8: "asfDefaultRipple",
  9: "asfDepositAuth",
  10: "asfAuthorizedNFTokenMinter",
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface LedgerTxRow {
  hash: string;
  ledger_index: number | null;
  /** Close time of the ledger that included it, ISO 8601 UTC. */
  date: string | null;
  type: string;
  /** Engine result, e.g. "tesSUCCESS" or "tecPATH_PARTIAL". */
  result: string;
  validated: boolean;
  account: string;
  account_role: string | null;
  destination: string | null;
  destination_role: string | null;
  /** Relative to the account being listed. */
  direction: "out" | "in" | "self" | "other";
  amount: string | null;
  currency: string | null;
  issuer: string | null;
  delivered_amount: string | null;
  source_tag: number | null;
  /** "multisig" (Signers[]) or "single" (one key signed). */
  signing: "multisig" | "single";
  signer_count: number;
  /** Signer role names (agent / cosigner / officer), or the address when unknown. */
  signer_roles: string[];
  memo: PaymentMemo | null;
  memo_type: string | null;
  /** Human summary of what the tx does (SignerListSet entries, AccountSet flag, TrustSet limit...). */
  details: string;
  fee_xrp: string | null;
  sequence: number | null;
  explorer_url: string;
  network: "testnet";
  /** Always true: a real Testnet transaction, but Testnet money (no value) paid to the fictional fixture nonprofits. */
  is_demo_data: true;
  /** Arrived over the live subscription (not the initial account_tx page). */
  live: boolean;
  /** The raw transaction fields (no metadata). */
  tx: Json;
}

const roleName = (roles: Map<string, RoleInfo>, address: string | null) => (address ? (roles.get(address)?.role ?? null) : null);

/**
 * Parse one account_tx entry or one "transaction" stream message. Handles API v1 ({tx, meta}, {transaction, meta})
 * and API v2 ({tx_json, hash, close_time_iso, meta}) shapes. Returns null if it is not a transaction.
 */
export function parseLedgerTx(entry: unknown, roles: Map<string, RoleInfo>, opts: { focus?: string; live?: boolean } = {}): LedgerTxRow | null {
  const e = obj(entry);
  const tx = obj(e.tx_json ?? e.tx ?? e.transaction);
  const hash = str(tx.hash) ?? str(e.hash);
  const type = str(tx.TransactionType);
  if (!hash || !type) return null;
  const meta = obj(e.meta ?? e.metaData);

  const dateSecs = num(tx.date) ?? num(e.date);
  const date = dateSecs !== null ? rippleTimeToIso(dateSecs) : (str(e.close_time_iso) ?? null);
  const account = str(tx.Account) ?? "";
  const destination = str(tx.Destination);
  const focus = opts.focus ?? null;
  const direction: LedgerTxRow["direction"] =
    focus === null ? "other" : account === focus && destination === focus ? "self" : account === focus ? "out" : destination === focus ? "in" : "other";

  const amt = parseAmount(tx.Amount ?? tx.DeliverMax);
  const delivered = parseAmount(meta.delivered_amount ?? meta.DeliveredAmount);

  const signerEntries = arr(tx.Signers).map((s) => str(obj(obj(s).Signer).Account) ?? "");
  const multisig = signerEntries.length > 0;
  const signer_roles = multisig ? signerEntries.map((a) => roleName(roles, a) ?? a) : ["account key"];

  const memos = decodeMemos(tx);
  const memo = paymentMemoOf(memos);

  let details = "";
  switch (type) {
    case "Payment": {
      const to = roleName(roles, destination) ?? destination ?? "?";
      details = amt ? `${amt.value} ${amt.currency} to ${to}` : `to ${to}`;
      if (delivered && amt && delivered.value !== amt.value) details += ` (delivered ${delivered.value} ${delivered.currency})`;
      if (memo) details += ` · invoice ${memo.inv}`;
      break;
    }
    case "SignerListSet": {
      const entries = arr(tx.SignerEntries).map((s) => obj(obj(s).SignerEntry));
      const list = entries.map((s) => `${roleName(roles, str(s.Account)) ?? str(s.Account)} (${num(s.SignerWeight) ?? "?"})`).join(", ");
      details = `signer list: ${list || "deleted"}; quorum ${num(tx.SignerQuorum) ?? "?"}`;
      break;
    }
    case "AccountSet": {
      const parts: string[] = [];
      const set = num(tx.SetFlag);
      const clear = num(tx.ClearFlag);
      if (set !== null) parts.push(`SetFlag ${set}: ${ACCOUNT_SET_FLAGS[set] ?? "?"}`);
      if (clear !== null) parts.push(`ClearFlag ${clear}: ${ACCOUNT_SET_FLAGS[clear] ?? "?"}`);
      details = parts.join("; ") || "account settings";
      break;
    }
    case "TrustSet": {
      const lim = parseAmount(tx.LimitAmount);
      details = lim ? `trust line ${lim.currency} (issuer ${roleName(roles, lim.issuer) ?? lim.issuer}), limit ${lim.value}` : "trust line";
      break;
    }
    default:
      details = type;
  }

  const result = str(meta.TransactionResult) ?? str(e.engine_result) ?? "unknown";
  return {
    hash,
    ledger_index: num(tx.ledger_index) ?? num(e.ledger_index) ?? num(tx.inLedger),
    date,
    type,
    result,
    validated: e.validated === true,
    account,
    account_role: roleName(roles, account),
    destination,
    destination_role: roleName(roles, destination),
    direction,
    amount: amt?.value ?? null,
    currency: amt?.currency ?? null,
    issuer: amt?.issuer ?? null,
    delivered_amount: delivered?.value ?? null,
    source_tag: num(tx.SourceTag),
    signing: multisig ? "multisig" : "single",
    signer_count: multisig ? signerEntries.length : 1,
    signer_roles,
    memo,
    memo_type: memos[0]?.type ?? null,
    details,
    fee_xrp: str(tx.Fee) ? dropsToXrp(String(tx.Fee)) : null,
    sequence: num(tx.Sequence),
    explorer_url: explorerTxUrl(hash),
    network: "testnet",
    is_demo_data: true,
    live: opts.live === true,
    tx,
  };
}

/** Merge two tx lists: dedupe by hash (first wins), newest ledger first (stable within a ledger). */
export function mergeTxRows(first: LedgerTxRow[], second: LedgerTxRow[]): LedgerTxRow[] {
  const seen = new Set<string>();
  const out: LedgerTxRow[] = [];
  for (const r of [...first, ...second]) {
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    out.push(r);
  }
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.ledger_index ?? Infinity) - (a.r.ledger_index ?? Infinity) || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal rippled JSON-over-WebSocket client: request/response by id, plus stream messages. */
export class LedgerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streamListeners = new Set<(msg: Json) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | null = null;

  private constructor(
    private readonly ws: WebSocket,
    readonly url: string,
  ) {
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev: CloseEvent) => this.onClosed(`connection closed (code ${ev.code})`));
    ws.addEventListener("error", () => this.onClosed("connection error"));
  }

  static connect(url: string = XRPL_TESTNET_WS, timeoutMs = 10_000): Promise<LedgerClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(new LedgerError("connect_failed", `Could not open ${url}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new LedgerError("connect_timeout", `No connection to ${url} after ${timeoutMs} ms`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new LedgerClient(ws, url));
      });
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LedgerError("connect_failed", `Could not connect to ${url}`));
      };
      ws.addEventListener("error", fail);
      ws.addEventListener("close", fail);
    });
  }

  get isOpen(): boolean {
    return this.closedReason === null && this.ws.readyState === 1;
  }

  /** Send one command; resolves with `result`, rejects with LedgerError(code = rippled `error`). */
  request(command: Json, timeoutMs = 20_000): Promise<Json> {
    if (this.closedReason !== null) return Promise.reject(new LedgerError("not_connected", this.closedReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LedgerError("timeout", `${String(command.command)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...command, id }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LedgerError("send_failed", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  onStream(cb: (msg: Json) => void): () => void {
    this.streamListeners.add(cb);
    return () => this.streamListeners.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(reason = "closed by client"): void {
    this.onClosed(reason);
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    const id = num(msg.id);
    if (msg.type === "response" && id !== null && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.status === "success") p.resolve(obj(msg.result));
      else {
        const code = str(msg.error) ?? "error";
        p.reject(new LedgerError(code, str(msg.error_message) ?? code));
      }
      return;
    }
    for (const cb of this.streamListeners) cb(msg);
  }

  private onClosed(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LedgerError("not_connected", reason));
    }
    this.pending.clear();
    for (const cb of this.closeListeners) cb(reason);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** account_tx for one account (default: agent_account), newest first, following `marker` up to `max` txs. */
export async function fetchAccountTx(
  client: LedgerClient,
  reg: Registry,
  opts: { account?: string; max?: number; pageSize?: number } = {},
): Promise<{ rows: LedgerTxRow[]; truncated: boolean }> {
  const account = opts.account ?? reg.agent_account;
  const max = opts.max ?? 400;
  const pageSize = opts.pageSize ?? 200;
  const roles = roleIndex(reg);
  const rows: LedgerTxRow[] = [];
  let marker: unknown = undefined;
  let pages = 0;
  do {
    const res = await client.request({
      command: "account_tx",
      account,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: Math.max(10, Math.min(pageSize, max - rows.length)),
      forward: false,
      ...(marker !== undefined ? { marker } : {}),
    });
    for (const e of arr(res.transactions)) {
      const row = parseLedgerTx(e, roles, { focus: account });
      if (row) rows.push(row);
    }
    marker = res.marker ?? undefined;
    pages++;
  } while (marker !== undefined && rows.length < max && pages < 25);
  return { rows: rows.slice(0, max), truncated: marker !== undefined || rows.length > max };
}

export interface SignerListState {
  quorum: number;
  entries: { address: string; role: string | null; weight: number }[];
}

export interface AccountState extends RoleInfo {
  /** ok = funded account; keypair = unfunded signing key (expected); not_found = expected account missing; error = query failed. */
  status: "ok" | "keypair" | "not_found" | "error";
  error: string | null;
  xrp: string | null;
  /** RLUSD balance on the trust line to the RLUSD issuer; null = no trust line (or the issuer itself). */
  rlusd: string | null;
  has_trust_line: boolean;
  sequence: number | null;
  owner_count: number | null;
  flags: number | null;
  master_disabled: boolean | null;
  signer_list: SignerListState | null;
  explorer_url: string;
  /** Always true: a real Testnet account, but Testnet balances have no value. */
  is_demo_data: true;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Live state of every registry role: XRP + RLUSD balances, flags, and agent_account's on-ledger signer list. */
export async function fetchAccountStates(client: LedgerClient, reg: Registry): Promise<AccountState[]> {
  const roles = roleIndex(reg);
  return mapLimit(registryRoles(reg), 4, async (r): Promise<AccountState> => {
    const base: AccountState = {
      ...r,
      status: "ok",
      error: null,
      xrp: null,
      rlusd: null,
      has_trust_line: false,
      sequence: null,
      owner_count: null,
      flags: null,
      master_disabled: null,
      signer_list: null,
      explorer_url: explorerAccountUrl(r.address),
      is_demo_data: true,
    };
    try {
      const info = await client.request({ command: "account_info", account: r.address, ledger_index: "validated", signer_lists: r.kind === "multisig_account" });
      const data = obj(info.account_data);
      const balance = str(data.Balance);
      base.xrp = balance ? dropsToXrp(balance) : null;
      base.sequence = num(data.Sequence);
      base.owner_count = num(data.OwnerCount);
      base.flags = num(data.Flags);
      base.master_disabled = base.flags !== null ? (base.flags & LSF_DISABLE_MASTER) !== 0 : null;
      // API v1 puts signer_lists inside account_data; v2 next to it.
      const lists = arr(data.signer_lists ?? info.signer_lists);
      if (lists.length > 0) {
        const l = obj(lists[0]);
        base.signer_list = {
          quorum: num(l.SignerQuorum) ?? 0,
          entries: arr(l.SignerEntries).map((s) => {
            const se = obj(obj(s).SignerEntry);
            const address = str(se.Account) ?? "";
            return { address, role: roles.get(address)?.role ?? null, weight: num(se.SignerWeight) ?? 0 };
          }),
        };
      }
      if (r.kind !== "rlusd_issuer") {
        const lines = await client.request({ command: "account_lines", account: r.address, peer: reg.rlusd.issuer, ledger_index: "validated" });
        const line = arr(lines.lines)
          .map(obj)
          .find((x) => x.currency === reg.rlusd.currency);
        if (line) {
          base.has_trust_line = true;
          base.rlusd = str(line.balance);
        }
      }
    } catch (err) {
      const code = err instanceof LedgerError ? err.code : "error";
      if (code === "actNotFound") base.status = r.kind === "signer_key" ? "keypair" : "not_found";
      else {
        base.status = "error";
        base.error = err instanceof LedgerError ? `${err.code}: ${err.message}` : String(err);
      }
    }
    return base;
  });
}

/** Subscribe to validated transactions touching these accounts ("transaction" stream messages). */
export async function subscribeAccounts(client: LedgerClient, accounts: string[]): Promise<void> {
  await client.request({ command: "subscribe", accounts });
}
