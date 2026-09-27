// Core routes of the xrpl service (see server.ts for the endpoint list). Side-effect free: importing this module loads
// no keys, so the officer / kill-switch / escrow routes (Phase 3, builder B) can be registered next to these.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { Invoice } from "../../../shared/contracts";
import { paths } from "../env";
import type { AgentCtx } from "../agent/payInvoice";
import { processSubmission } from "../agent/pipeline";
import type { Registry } from "../lib/registry";
import { EIN_RE } from "../lib/credentials";
import type { InvoiceInput } from "../verifier";
import { createPayeeChangeRequest, listPayeeChangeRequests, notifyCosignerOfHold } from "./payeeChange";
import { health, policyProblems } from "../../scripts/_cosigner";

export interface ServiceDeps {
  ctx: AgentCtx;
  db: Db;
  reg: Registry;
  cosignerUrl: string;
  /** Runs signing work one request at a time. */
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
}

const INVOICE_DIR = path.join(paths.dataDir, "invoices");
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function inputFromBody(b: Record<string, unknown>): { input: InvoiceInput; contract_id: string; invoice_id?: string; via: Invoice["submitted_via"] } | string {
  if (b.invoice && typeof b.invoice === "object") {
    const inv = b.invoice as Partial<Invoice>;
    if (typeof inv.contract_id !== "string" || !ID_RE.test(inv.contract_id)) return "invoice.contract_id is required";
    if (typeof inv.invoice_id !== "string" || !inv.invoice_id) return "invoice.invoice_id is required";
    const via = inv.submitted_via === "imessage" || inv.submitted_via === "seed" ? inv.submitted_via : "web";
    return { input: { kind: "json", text: JSON.stringify(inv, null, 2), name: `api-${inv.invoice_id}.json` }, contract_id: inv.contract_id, invoice_id: inv.invoice_id, via };
  }
  const contract_id = b.contract_id;
  if (typeof contract_id !== "string" || !ID_RE.test(contract_id)) return "contract_id is required with invoice_text / pdf_path";
  const invoice_id = typeof b.invoice_id === "string" && b.invoice_id ? b.invoice_id : undefined;
  if (typeof b.invoice_text === "string") {
    if (!b.invoice_text.trim() || b.invoice_text.length > 20000) return "invoice_text must be 1..20000 characters";
    return { input: { kind: "text", text: b.invoice_text, name: `api-${invoice_id ?? "text"}.txt` }, contract_id, invoice_id, via: "web" };
  }
  if (typeof b.pdf_path === "string") {
    const file = path.resolve(INVOICE_DIR, b.pdf_path);
    if (!file.startsWith(INVOICE_DIR + path.sep) || !/\.pdf$/i.test(file) || !fs.existsSync(file)) return `pdf_path must name an existing .pdf under xrpl/data/invoices/`;
    return { input: { kind: "pdf", file, name: path.basename(file) }, contract_id, invoice_id, via: "web" };
  }
  return "body must contain invoice, invoice_text or pdf_path";
}

/** The core routes. The officer service / approvals / kill switch (Phase 3, builder B) register their own routes next to these. */
export function registerCoreRoutes(app: FastifyInstance, d: ServiceDeps): void {
  app.get("/health", async () => {
    const h = await health(d.cosignerUrl);
    return {
      ok: true,
      role: "xrpl-service",
      agent_signer: d.ctx.agentWallet.address,
      agent_account: d.reg.agent_account,
      cosigner: { url: d.cosignerUrl, up: !!h, rule_version: h?.rule_version ?? null, policy_problems: h ? policyProblems(h) : null },
    };
  });

  app.post("/invoices", (req, reply) =>
    d.serial(async () => {
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ ok: false, error: "bad_request", message: "body must be a JSON object" });
      const parsed = inputFromBody(body);
      if (typeof parsed === "string") return reply.code(400).send({ ok: false, error: "bad_request", message: parsed });
      const h = await health(d.cosignerUrl);
      const problems = h ? policyProblems(h) : [];
      if (problems.length) return reply.code(503).send({ ok: false, error: "cosigner_policy_mismatch", message: `the co-signer at ${d.cosignerUrl} does not run the root .env policy: ${problems.join("; ")}` });
      const r = await processSubmission({ input: parsed.input, contract_id: parsed.contract_id, expected_invoice_id: parsed.invoice_id, submitted_via: parsed.via }, d.ctx);
      return reply.send({ ok: true, decision: r.decision, stage: r.stage, destination: r.destination, explorer_url: r.explorer_url, recorded: r.recorded });
    }),
  );

  app.post("/payees/:ein/change-request", async (req, reply) => {
    const { ein } = req.params as { ein: string };
    const r = await createPayeeChangeRequest(d.db, ein, req.body);
    if (!r.ok) return reply.code(r.status).send({ ok: false, error: r.error, message: r.message });
    const cosigner = await notifyCosignerOfHold(d.cosignerUrl);
    d.ctx.log(`payee change request ${r.request.request_id} for EIN ${ein} -> ${r.request.requested_address}: ON HOLD until ${r.request.hold_until} (registry unchanged; co-signer ${cosigner.recorded ? "recorded it" : "will record it on its next read"})`);
    return reply.code(202).send({ ok: true, request: r.request, cosigner });
  });

  app.get("/payees/:ein/change-requests", async (req, reply) => {
    const { ein } = req.params as { ein: string };
    if (!EIN_RE.test(ein)) return reply.code(400).send({ ok: false, error: "bad_request", message: "ein must be NN-NNNNNNN" });
    return { ok: true, requests: await listPayeeChangeRequests(d.db, ein) };
  });
}
