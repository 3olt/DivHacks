# XRPL payment agent

> **Moved.** The agent now lives in [`../xrpl/`](../xrpl/), and it reports to the Fastify API in [`../api/`](../api/) (`POST /events/payment`, WebSocket `/live`) instead of `POST /api/payments` on the Next.js app. The frontend contract is [`../docs/API.md`](../docs/API.md). The notes below are the original plan, kept for reference.

TypeScript. Owner: XRPL teammate. See `../context.md` ("Payee verification", "Edge cases and guardrails", "Integration: agent → frontend").

## Reporting to the frontend

After every payment decision (released, held in escrow, or refused), POST it to the frontend:

```
POST http://localhost:3000/api/payments
Content-Type: application/json

{
  "invoice_id": "INV-2026-0042",
  "contract_id": "CT1-071-20261234",
  "payee_ein": "12-3456789",
  "payee_wallet": "r...",
  "amount_xrp": "25",
  "status": "released",          // released | held_escrow | refused
  "refusal_reason": null,        // required when status is "refused"
  "xrpl_tx_hash": "ABC123...",   // testnet tx hash; null if refused
  "agent_reasoning": "Milestone verified; within contract cap; credential valid"
}
```

- Required: `invoice_id`, `contract_id`, `payee_ein`, `payee_wallet`, `amount_xrp`, `status`, `agent_reasoning`.
- A `released` payment turns every map pin whose nonprofit has that `payee_ein` green.
- Type definition: `../web/src/lib/types.ts` (`Payment`).
- Demo EINs in `../web/src/lib/mockData.ts` run from `00-0000001` to `00-0000006`. Use these until real data is loaded.
