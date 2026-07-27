
# Sales Document Printing — Architectural Investigation & Migration Plan

## 1. Canonical pipeline (what exists in the codebase today)

The ERP already declares a canonical intent-driven printing pipeline. It is documented in ADRs and implemented for Labels:

```text
Business event / user action
   ↓
Document record (document_records)                 ← persistence of the intent
   ↓
submit_document_intent  (RPC)                       ← Wave-5 chokepoint
   ↓
print_jobs   (one row per resolved target)          ← queue / ledger
   ↓
dispatch-print-jobs worker
   ↓
generate-document       (Line[] AST → PDF/ESC/POS)  ← rendering owner
   ↓
PrintClient / labelDispatch                         ← engine + policy
   ↓
HardwareClient → hardware.route.decision            ← device + transport
   ↓
Local Agent (FIFO) → printer
```

Key single-owner rules already ratified:
- **ADR-0084 / 0086** — `Line[]` AST is the only printable shape.
- **ADR-0085** — one module owns each byte kind (PDF, ESC/POS, ZPL).
- **ADR-0090** — `labelCompiler` is the single owner of label templates.
- **Wave-5** — `submit-document-intent` edge fn + `submit_document_intent` RPC is the only sanctioned way to dispatch a document; `print_jobs` is the only queue.

Labels comply end-to-end: `Products.tsx` → `useLabelPrint` → `labelDispatch` → `PrintClient` → `print_jobs` → hardware. This is why the "hardware.route.decision" log appears and the physical printer receives every job.

## 2. Current Sales-invoice pipeline (as implemented)

```text
Invoices.tsx  (row action)
   ↓
setState(printDocumentType='invoice', printDocumentId=id)
   ↓
<PrintPreviewDialog open documentType documentId />
   ↓
useEffect → raw fetch POST {supabaseUrl}/functions/v1/generate-document
   body: { documentType:'invoice', documentId, format:'pdf', branchId }
   ↓
[FAILS HERE with HTTP 400]
   ↓ (never runs)
   PrintClient.printPdf / hardware routing / print_jobs / Agent
```

Verified from source:
- `src/pages/Invoices.tsx:45,665` opens `PrintPreviewDialog` with `documentType="invoice"` + `documentId`.
- `src/components/common/PrintPreviewDialog.tsx:180-199` performs a raw `fetch()` to `/functions/v1/generate-document`; a non-2xx surfaces as `Request failed (400)` and the dialog is closed.
- `supabase/functions/generate-document/index.ts:154-167` fetches the invoice with `.single()` and embeds `contact:contacts`, `organization:organizations(${ORG_FALLBACK_COLS})`, `business:businesses(${BUSINESS_BRANDING_COLS})`, `invoice_items(*, packaging:product_packaging, product:products(base_uom:units_of_measure!base_uom_id))`. `.single()` returns 400 (`PGRST116`) whenever zero or >1 rows match, and any embedded FK that no longer exists returns 400 as well.
- `src/features/sales/useInvoiceRecord.ts` uses a **different** select (`contact:contacts(name,email,phone), invoice_items(*)`) and `.maybeSingle()`. The peek sheet works; the print path uses a divergent, wider select against the edge function.

## 3. Point of divergence from canonical

Sales invoicing NEVER enters the canonical intent pipeline:

| Stage | Labels (canonical) | Invoices (current) |
|---|---|---|
| Intent record | `document_records` + `submit_document_intent` | none |
| Queue | `print_jobs` row per target | none |
| Renderer entry | worker calls `generate-document` after target resolution | client calls `generate-document` directly, synchronously, for preview |
| Hardware resolution | `dispatch-print-jobs` → `PrintClient` → `HardwareClient` | never reached |
| Ledger | `print_jobs` history + retries | nothing recorded on 400 |
| Failure mode | job row in `failed` state, visible, retryable | opaque toast, no trace |

So the Sales pipeline is a **synchronous preview-first shortcut** that bypasses `submit_document_intent`, `print_jobs`, `PrintClient`, and `HardwareClient` entirely. This is the architectural drift.

## 4. Root cause of the HTTP 400

The 400 is emitted by `generate-document` before any rendering happens, from the `fetchInvoice` PostgREST call at `supabase/functions/generate-document/index.ts:154-167`. Two possible triggers, both must be verified against the live schema before a fix:

1. **Embedded relationship no longer resolvable.** The select requests `product_packaging`, `units_of_measure!base_uom_id`, `organizations(${ORG_FALLBACK_COLS})`, `businesses(${BUSINESS_BRANDING_COLS})`. If any of those tables/columns/FKs have drifted (renamed, dropped, or the FK metadata is missing), PostgREST returns 400 with `PGRST200`. The peek-sheet hook uses a narrower select and works, which strongly implicates one of these embeds.
2. **`.single()` on a mismatched id.** `.single()` returns 400 (`PGRST116`) for zero rows. Less likely, because the record is opened from a list of real ids, but must be excluded by inspecting the actual response body.

Either way, the true remedy is not to patch this select — it is to stop having a client synchronously invoke `generate-document` for print at all. The rendering call must live inside the worker consuming `print_jobs`. Preview PDF can share the same rendering endpoint, but only after the intent row exists, so failures are ledgered.

## 5. Duplicate / legacy implementations found

- Invoice fetch is duplicated: `useInvoiceRecord` (client, narrow) and `fetchInvoice` inside `generate-document` (wide, drift-prone).
- The client fetch for preview bytes in `PrintPreviewDialog` (raw `fetch` with hand-rolled auth headers) duplicates `supabase.functions.invoke` behavior used elsewhere.
- `PrintPreviewDialog` is imported by every Sales page (`Invoices`, `Estimates`, `SalesOrders`, `DeliveryNotes`, `ProformaInvoices`, `SalesReturns`) — all six take the same shortcut and skip the intent pipeline.
- Labels correctly go through `useLabelPrint` + `labelDispatch` and never touch `PrintPreviewDialog`.

## 6. Migration plan — one pipeline for every printable document

### Phase 0 — Prove the exact 400 (no code changes)

- Reproduce the request and read the JSON body / PostgREST error code. Confirms which embed is at fault.
- Snapshot the current `invoices → products → units_of_measure`, `product_packaging`, `businesses`, `organizations` FKs.

### Phase 1 — Introduce a `useDocumentPrint` seam (mirror of `useLabelPrint`)

New hook: `src/hooks/documents/useDocumentPrint.ts`.

Contract:
```ts
const { print, preview, missingDeviceCta } = useDocumentPrint({ branchId });
await print({ documentType: 'invoice', documentId, scenario: 'default' });
```

Behavior:
1. Ensure a `document_records` row exists for `(documentType, documentId)` — create-if-missing via a small RPC (`ensure_document_record`).
2. Call `submit-document-intent` edge fn (already in the repo) to enqueue `print_jobs`.
3. Return the job ids so the UI can subscribe to progress via `print_jobs` realtime.
4. For **preview**, call `generate-document` but only after step 1, and mark the resulting artifact under `document_artifacts` (Wave-4 already models this).

This mirrors the Labels architecture exactly.

### Phase 2 — Rewrite `PrintPreviewDialog` as a thin viewer

- Remove all raw `fetch('/generate-document')` from the dialog.
- Dialog receives a `documentRecordId` + optional `previewArtifactId` and only renders/prints from the intent's produced artifact.
- Destination selection stays; on "Print", it calls `useDocumentPrint().print()` with the chosen target override, NOT `PrintClient.printPdf` directly.

### Phase 3 — Route every Sales page through the seam

Change six pages (`Invoices`, `Estimates`, `SalesOrders`, `DeliveryNotes`, `ProformaInvoices`, `SalesReturns`) to call `useDocumentPrint` instead of setting `PrintPreviewDialog` state. Same pattern the Products page uses for labels.

### Phase 4 — Consolidate invoice fetch

- Keep `useInvoiceRecord` as the ONLY client-side invoice fetch (peek + record page).
- Rewrite `fetchInvoice` inside `generate-document` to use a minimal, verified select that matches actual schema (drop unused embeds, or split embeds into two staged queries). Cover with a fetcher smoke test analogous to `hr-letters-registered_test.ts`.

### Phase 5 — Delete drift

- Remove `PrintPreviewDialog`'s raw fetch, its bespoke auth header assembly, its ESC/POS second-fetch path.
- Remove any per-page divergent print buttons that construct print intents inline.
- Add an ESLint rule `no-direct-generate-document-in-pages` (there is already `no-direct-generate-document-in-pages.js` scaffolded in `eslint-rules/`) — enable it repo-wide.
- Add a runtime architecture test: any page that prints must go through `useDocumentPrint` or `useLabelPrint`.

### Phase 6 — Verify canonical parity

For every printable business doc (invoice, estimate, SO, DN, proforma, sales return, credit note, PO, bill, receipt, statement):
1. `submit-document-intent` produces a `print_jobs` row.
2. `dispatch-print-jobs` logs `hardware.route.decision`.
3. Agent FIFO receives one job per target.
4. Failures land on `print_jobs.status='failed'`, not on a client toast.

Success metric: printing an invoice produces the SAME log signature as printing a product label — same hooks, same queue, same routing decision, same transport.

## 7. Technical notes

- `submit_document_intent` RPC and `submit-document-intent` edge function already exist (`supabase/functions/submit-document-intent/index.ts`); no new backend surface is required for dispatch.
- `document_records`, `document_artifacts`, `print_jobs` tables already exist per Wave-4/Wave-5.
- `generate-document` stays the single renderer (ADR-0085). Only its invocation site moves: client → worker/preview-under-intent.
- `PrintClient` continues to own PDF/ESC/POS dispatch mechanics; it is invoked from the worker, not the UI.
- No schema migration is strictly required for the migration; a select fix in `fetchInvoice` may be a one-line follow-up once Phase-0 identifies the offending embed.

## 8. Deliverables

1. This report (Phase 0 findings will be appended once the 400 body is captured).
2. `useDocumentPrint` hook + wiring for all six Sales pages.
3. Slimmed `PrintPreviewDialog` (viewer only).
4. `fetchInvoice` select repaired + test.
5. ESLint rule enabled; architecture test added.
6. Removal of all shadow print paths in `src/pages/*.tsx` for sales documents.

Outcome: one deterministic pipeline from business event → `document_records` → `submit_document_intent` → `print_jobs` → `generate-document` (Line[] AST) → `PrintClient` → `HardwareClient` → Agent → printer, shared by labels and every sales/purchase/finance document.
