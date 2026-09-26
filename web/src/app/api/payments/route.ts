import { getPayments, recordPayment } from "@/lib/store";
import type { Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getPayments());
}

// The XRPL agent POSTs each payment decision here (released, held_escrow or refused).
export async function POST(req: Request) {
  const body = (await req.json()) as Partial<Payment>;
  const required = ["invoice_id", "contract_id", "payee_ein", "payee_wallet", "amount_xrp", "status", "agent_reasoning"] as const;
  const missing = required.filter((k) => !body[k]);
  if (missing.length) return Response.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400 });

  const payment: Payment = {
    invoice_id: body.invoice_id!,
    contract_id: body.contract_id!,
    payee_ein: body.payee_ein!,
    payee_wallet: body.payee_wallet!,
    amount_xrp: body.amount_xrp!,
    status: body.status!,
    refusal_reason: body.refusal_reason ?? null,
    xrpl_tx_hash: body.xrpl_tx_hash ?? null,
    agent_reasoning: body.agent_reasoning!,
    created_at: body.created_at ?? new Date().toISOString(),
  };
  recordPayment(payment);
  return Response.json(payment, { status: 201 });
}
