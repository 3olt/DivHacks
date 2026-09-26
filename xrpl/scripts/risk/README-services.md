# Grok (xAI) and Nessie (Capital One): Phase 0 service checks

Checked on 2026-09-26. Both scripts can be re-run and never print API keys.

```bash
cd xrpl
npx tsx scripts/risk/grok.ts                 # G1: add XAI_API_KEY to the repo-root .env first for the authenticated checks
npx tsx scripts/risk/grok.ts --no-vision     # skip the image-input check
npx tsx scripts/risk/nessie.ts               # N1: read-only; add NESSIE_API_KEY to .env for the authenticated GETs
npx tsx scripts/risk/nessie.ts --write-smoke # opt-in: creates a throwaway customer, account and deposit, then deletes the account and deposit
```

Each script ends with a line `RESULT_JSON [...]` and exits with code 1 if any check FAILs. A BLOCKED check (missing key) still exits 0.
Optional overrides: `GROK_MODEL` (default `grok-4.3`), `GROK_VISION_MODEL`, `GROK_REASONING_EFFORT`, `XAI_BASE_URL`, `NESSIE_BASE_URL`.

---

## Grok (xAI)

### Results
| Check | Status | Evidence |
|---|---|---|
| G1-reach | PASS | `GET https://api.x.ai/v1/models` with no key returns HTTP 401 `{"code":"unauthenticated:no-credentials","error":"No credentials presented."}` (Cloudflare, about 140 to 260 ms) |
| G1-auth | BLOCKED | `XAI_API_KEY` is empty. With a key, the script lists models, runs a Chat Completions `json_schema` call returning `{ok, model}`, runs the same call through the Responses API, and runs an image-input call. |

A wrong key returns **HTTP 400** `{"code":"invalid-argument","error":"Incorrect API key provided. ..."}`, not 401. The script reports this as "key rejected".

### API facts (from docs.x.ai; every page is also available as `.md`)
- **Base URL:** `https://api.x.ai/v1`. There is also a US-only regional endpoint, `https://us.api.x.ai/v1`, priced 10% higher.
- **Auth header:** `Authorization: Bearer $XAI_API_KEY`. Keys come from console.x.ai; a human has to create the account.
- **Endpoints:**
  - `POST /v1/responses` is the recommended endpoint.
  - `POST /v1/chat/completions` still works but the docs label it "Legacy" and, in the comparison table, "Deprecated". The OpenAI SDK works if you set `baseURL`.
  - Other endpoints: `GET /v1/models`, `GET /v1/language-models` (includes `input_modalities`), and `POST /v1/files`.
- **Current text models (all have text + image input, text output, and structured outputs):**

  | Model id | Context | $ in/out per 1M | Reasoning | Notes |
  |---|---|---|---|---|
  | `grok-4.7` | 500k | 2.00 / 6.00 | low, medium, high (default), xhigh; cannot be disabled | Frontier model (September release). Documented as the "most capable". |
  | `grok-4.6`, `grok-4.5` | 500k | 2.00 / 6.00 | low to xhigh (default high) | |
  | `grok-4.3` (alias `grok-4.3-latest`) | 1M | 1.25 / 2.50 | **none**, low (default), medium, high, xhigh | Documented as "Fast, reliable model with strong tool calling and instruction following". Retired models (`grok-3`, `grok-4-fast-*`, `grok-4-0709`) now redirect here. |
  | `grok-4.20-0309-non-reasoning` (alias `grok-4.20-non-reasoning`) | 1M | 1.25 / 2.50 | none | Fast, with no reasoning. |
  | `grok-4.20-0309-reasoning` (alias `grok-4.20`) | 1M | 1.25 / 2.50 | yes | |
  | `grok-build-0.1` (alias `grok-code-fast-1`) | 256k | 1.00 / 2.00 | yes | Coding model. |
- **Model to use:**
  - (a) Fast text with structured outputs: `grok-4.3`, with `reasoning_effort` set to `none` or `low`. `grok-4.20-non-reasoning` also works.
  - (b) Vision (image input): `grok-4.3`, which is the script default. Use `grok-4.7` when quality matters more than latency or cost.
  - Every model above accepts images, so one model can do both jobs.
- **Structured outputs:** supported by every text model above; each model page says "Structured outputs: Yes".
  - Chat Completions: `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}`.
  - Responses API: `text: {format: {type: "json_schema", name, schema, strict: true}}`.
  - `json_object` and `text` are also accepted.
  - The docs say that with supported schema features the output "is guaranteed to match your schema".
  - Schema rules:
    - `additionalProperties` defaults to `false`.
    - `format` is enforced only for date, time, date-time, email, uuid, ipv4, ipv6 and uri.
    - `pattern` supports a subset of regex, with implicit anchors.
    - `minLength`/`maxLength` are guaranteed up to 2048.
    - Empty `enum` values, `true`/`false` property schemas, and array-form `items` are rejected with HTTP 400.
- **Images:**
  - Responses API format: `{type: "input_image", image_url: "data:image/png;base64,..." | "https://...", detail: "high"}`.
  - Chat Completions format: `{type: "image_url", image_url: {url, detail}}`.
  - Only jpg/jpeg and png are accepted, at most 20 MiB each, with no limit on count.
  - The docs advise not storing history when sending images, so send `store: false` on the Responses API.
- **PDFs:**
  - PDFs cannot be sent as image input, which accepts png and jpg only.
  - A PDF can be attached as `{type: "input_file", file_url}` or `{type: "input_file", file_id}`. The `file_id` comes from `POST /v1/files`, which accepts up to 50 MB. This is listed under "Chat with Files".
  - Attaching a file "automatically enables document search capabilities, transforming your request into an agentic workflow". That requires an agentic-capable model (grok-4.20, 4.5, 4.6 or 4.7) and cannot use batch mode.
  - **Recommendation for the Phase 2 verifier:** do not use file attachments; they are nondeterministic and cost extra tokens. Instead, extract the PDF text locally, or rasterize its pages to PNG, and send that as text or `image_url`.
  - Node has no PDF library installed, so this needs a new dependency such as `pdfjs-dist`. Python already has `pypdf` and PyMuPDF (`fitz`), which a data/ helper could use.
- **Other rules:**
  - Reasoning models reject `presencePenalty`, `frequencyPenalty` and `stop`.
  - `logprobs` is ignored on grok-4.20 and newer.
  - `grok-4.7` accepts `reasoning_effort` low, medium, high or xhigh, but not `none`.

Sources:
- https://docs.x.ai/llms.txt
- https://docs.x.ai/developers/quickstart.md
- https://docs.x.ai/developers/models.md
- https://docs.x.ai/developers/models/grok-4.3.md (also grok-4.7, grok-4.6, grok-4.5, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning and grok-build-0.1)
- https://docs.x.ai/developers/grok-4-7.md
- https://docs.x.ai/developers/model-capabilities/text/structured-outputs.md
- https://docs.x.ai/developers/model-capabilities/images/understanding.md
- https://docs.x.ai/developers/model-capabilities/legacy/chat-completions.md
- https://docs.x.ai/developers/model-capabilities/text/comparison.md
- https://docs.x.ai/developers/model-capabilities/files/chat-with-files.md
- https://docs.x.ai/developers/files.md
- https://docs.x.ai/developers/rest-api-reference/files/upload.md
- https://docs.x.ai/developers/rest-api-reference/inference/models.md
- https://docs.x.ai/developers/debugging.md
- https://docs.x.ai/developers/migration/may-15-retirement.md
- https://docs.x.ai/developers/release-notes.md

---

## Nessie (Capital One)

### Results
| Check | Status | Evidence |
|---|---|---|
| N1-reach-http | INFO | `http://api.nessieisreal.com` fails to connect on port 80 (ETIMEDOUT). DNS resolves, and plain-HTTP sites such as example.com work from the same network, so Nessie itself does not serve HTTP. **Use `https://`**, not the `http://` URL written in context.md and the prompt. |
| N1-reach-https | PASS | `https://api.nessieisreal.com` runs on AWS API Gateway. `/atms?key=invalid` returns 200 with 13 ATMs (public data). `/customers?key=invalid` and `/accounts?key=invalid` return 200 `[]`. `/customers` with no key returns 502 `{"message": "Internal server error"}`. `/customers/{unknown}` returns 404 `"Customer not found"`. An unknown route returns 403 `{"message":"Missing Authentication Token"}`. |
| N1-spec | PASS | The OpenAPI 3.0.3 spec that the docs page loads is at **https://nessieisreal.com/nessie-openapi-spec.yaml** (73,934 bytes). It contains every endpoint listed below. |
| N1-auth | BLOCKED | `NESSIE_API_KEY` is empty. |

### Getting a key
A human logs in at https://nessieisreal.com using GitHub OAuth, then copies the key from the Docs page ("Authentication" section) into the repo-root `.env` as `NESSIE_API_KEY=`. The key goes in as a query parameter, `?key=...`, on every request.

### Endpoints for Phase 3 payee verification
The base URL is `https://api.nessieisreal.com`. The Getting Started page uses this host. The spec lists `https://prod-api.nessieisreal.com`, which behaves the same.

| Purpose | Method + path | Body (required fields in **bold**) | Documented success response |
|---|---|---|---|
| Create customer (name + address) | `POST /customers?key=` | **first_name**, **last_name**, **address** {**street_number**, **street_name**, **city**, **state**, **zip**} (all strings) | 201 `"Customer created"` |
| Get customer | `GET /customers/{id}?key=` | none | 200 Customer `{_id, first_name, last_name, address}`; 404 `"Customer not found"` |
| List customers | `GET /customers?key=` | none | 200 Customer[] |
| Update customer | `PUT /customers/{id}?key=` | first_name, last_name, address (all optional) | 202 |
| Create account for customer | `POST /customers/{id}/accounts?key=` | **type** (`Checking` \| `Savings` \| `Credit Card`), **nickname**, **rewards** (int >= 0), **balance** (int >= 0). `account_number` is **not** part of the create body; the server assigns a 16-digit number. | 201 `"Account created"` |
| List a customer's accounts | `GET /customers/{id}/accounts?key=` | none | 200 Account[] `{_id, type, nickname, rewards, balance, account_number, customer_id}` |
| Account's owner (for name/address match) | `GET /accounts/{id}/customer?key=` | none | 200 Customer |
| Get account / list all accounts | `GET /accounts/{id}?key=`, `GET /accounts?key=` | none | 200 |
| Create deposit (micro-deposit) | `POST /accounts/{id}/deposits?key=` | **medium**, **transaction_date**, **status**, **amount** (**integer**), **description**. The docs example uses `medium: "balance"`, `status: "completed"` and `transaction_date: "2025-03-15"`. | 201 `"Deposit created"` |
| List deposits for account | `GET /accounts/{id}/deposits?key=` | none | 200 Deposit[] |
| Get / update deposit | `GET /deposits/{id}?key=`, `PUT /deposits/{id}?key=` | none for GET; for PUT, any of medium, transaction_date, status, amount, description | 200 / 202 |
| Cleanup | `DELETE /deposits/{id}?key=`, `DELETE /accounts/{id}?key=` | none | 200 |

### Quirks that affect Phase 3 (these need handling in code)
1. **No DELETE for customers.** The spec has no `DELETE /customers/{id}`, and I found no bulk `/data` delete. Test customers stay forever, so each nonprofit should get one customer, reused across runs (idempotent).
2. **POST may not return the new id.** The spec documents the 201 body as a plain string ("Customer created"). Look the record up afterwards with a unique field. Suggestion: set `last_name` to the EIN, e.g. `EIN 12-3456789`, and `first_name` to the legal name. Nessie customers are person-shaped, and this makes the lookup unique. The `--write-smoke` run shows what production actually returns.
3. **IDs are 36-character UUIDs**, not the 24-character ids the spec says. I saw this in live `/enterprise/customers` data. Do not validate ids by length.
4. **Deposit `amount` is an integer.** Micro-deposits must be whole numbers. Suggested convention: two deposits of 1 to 99, treated as cents by our app. The nonprofit proves control by reporting both amounts; do not put the code in `description`.
5. **Invalid keys are not rejected on GET.** `GET /customers?key=anything` returns 200 `[]`, not the 401 the spec documents. A key only counts as proven once a POST succeeds or a GET returns our own data. I did not send any POST in this session.
6. **Privacy: `/enterprise/*` is readable across all users with any key.** `GET /enterprise/customers?key=invalid` returned **1,305 customers belonging to other users** (fields `_id`, `first_name`, `last_name`, `address`, `account_ids`). I recorded only the count and field names, not the data. Never put personal data into Nessie; use only organization names and public addresses. Do not build features on `/enterprise`.
7. **Plain HTTP is dead.** Use `https://` everywhere.

Sources:
- https://nessieisreal.com (a React app; the Docs route loads `/nessie-openapi-spec.yaml`; Getting Started shows `api.nessieisreal.com/customers?key=...`)
- https://nessieisreal.com/nessie-openapi-spec.yaml
- the live probes above
