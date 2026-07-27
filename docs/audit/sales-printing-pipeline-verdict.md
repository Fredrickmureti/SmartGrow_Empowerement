# Sales Printing Pipeline — Investigation Verdict

Status: Investigation only. No behavioural code changes made this turn.
Date: 2026-07-27.

## TL;DR

The enterprise-grade intent-driven pipeline you specified **already exists
and is already wired into every Sales page** (Wave 7.2). Both the client-side
fetch+snapshot and the `submit-document-intent` chokepoint are present. The
`HTTP 400 during the invoice retrieval request` you observed is **not** in
that path — it is in the surviving **preview** shadow path
(`PrintPreviewDialog` → `functions/generate-document`), which is the last
piece of the migration that has not been retired.

## Verified current state (evidence)

### Canonical print flow — already in place

| Page                    | Snapshot builder                              | Ensure record        | Submit intent          |
|-------------------------|-----------------------------------------------|----------------------|------------------------|
| `pages/Invoices.tsx`    | `fetchAndBuildSalesInvoiceSnapshot`           | `ensureDocumentRecord` | `submitDocumentIntent` |
| `pages/Estimates.tsx`   | `fetchAndBuildSalesEstimateSnapshot`          | ✓                    | ✓                      |
| `pages/DeliveryNotes.tsx` | `fetchAndBuildSalesDeliveryNoteSnapshot`    | ✓                    | ✓                      |
| `pages/SalesOrders.tsx` | `fetchAndBuildSalesOrderSnapshot`             | ✓                    | ✓                      |
| `pages/SalesReturns.tsx` | `fetchAndBuildSalesReturnSnapshot`           | ✓                    | ✓                      |
| `pages/ProformaInvoices.tsx` | `fetchAndBuildSalesProformaSnapshot`     | ✓                    | ✓                      |

Server contract:

- `submit_document_intent` RPC — resolves Wave-4 routing plan and enqueues
  `print_jobs` rows. Called via the `submit-document-intent` edge function.
- `ensure_document_record` RPC — idempotent upsert into `document_records`
  with the frozen snapshot. Two migrations already deployed
  (`20260727131349`, `20260727131535`).
- Downstream `print_jobs` workers own byte rendering and hardware routing
  per ADR-0085.

Guardrails already in place: `no-direct-generate-document-in-pages`,
`no-printservice-shim`, `no-document-print-shadow-path`,
`no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`,
`no-raw-pdf-lib-in-app`.

**Conclusion:** Phases 1, 3 and 5 of the plan I proposed earlier are already
delivered. There is no `useDocumentPrint` hook to build — the equivalent is
three inline lines per page against the canonical services, and every page
already does exactly that.

### Where a shadow still exists

`src/components/common/PrintPreviewDialog.tsx` accepts
`documentType`/`documentId`, invokes `functions/generate-document`
synchronously to fetch a **PDF preview blob**, and renders it in an
`<iframe src=blob:>`. Every Sales page still wires that dialog for the "Eye"
preview action. That is:

1. The only remaining app-level caller of `generate-document`.
2. The only remaining code that re-derives `DocumentData` server-side
   through PostgREST embeds — the exact query that is 400-ing.

This is not "printing" in the enterprise sense; it is on-screen preview.
The canonical replacement is: after `submitDocumentIntent`, workers write to
`document_artifacts`; the preview reads that artifact by
`document_record_id` and streams the immutable PDF. `generate-document` is
then only invoked as a fall-forward for artifacts that have not yet been
materialized (or is removed entirely once every kind has a worker).

### Root cause of the reported HTTP 400 — best hypothesis, unconfirmed

`fetchInvoice` (`supabase/functions/generate-document/index.ts:154-165`)
uses these PostgREST embed hints:

```
contact:contacts(...),
organization:organizations(id),
business:businesses(id, name, legal_name, logo_url, email, phone, address, city, state, postal_code, country, tax_id, registration_number, base_currency, timezone),
invoice_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
```

Evidence gathered:

- Every FK referenced by these embeds is present in `pg_constraint`
  (verified: `invoice_items_product_id_fkey`,
  `invoice_items_packaging_id_fkey`,
  `products_base_uom_id_fkey`, `invoices→businesses`, `invoices→organizations`).
- Every column in `BUSINESS_BRANDING_COLS` exists on `businesses`
  (verified against a real row for `Joshua Holdings`).
- A hand-rolled equivalent of the join runs cleanly as service-role.

But this comment in `src/services/documents/snapshots/salesInvoice.ts:194`
was written by whoever last touched `fetchAndBuild…`:

> "This installation intentionally has no FK relationships on
> invoices/invoice_items, so schema-cache embeds such as
> `product:products(...)` fail with PGRST200 before routing begins."

The FKs *are* in `pg_constraint` today. This means one of:

1. **PostgREST schema cache is stale** — FKs were added but PostgREST was
   not reloaded (`NOTIFY pgrst, 'reload schema'` or a restart). The embed
   fails with `PGRST200 (Could not find a relationship...)`, which
   PostgREST returns as **HTTP 400** with a JSON body naming the missing
   relationship. This is the most likely cause and is a well-documented
   Supabase behaviour after a fresh FK migration.
2. **A prior teardown script dropped the FKs and they were re-added later**
   — the `salesInvoice.ts` comment was accurate when written but is now
   stale, and PostgREST hasn't been reloaded to see the re-added FKs.
3. **`ORG_FALLBACK_COLS = "id"`** is fine, but `business_id` on an invoice
   is `NOT NULL` in practice yet `mapBusinessToOrg` falls back to `organizations`
   which has only `id`. Not a 400 cause, but a silent branding bug.

I cannot confirm which without capturing the actual 400 response body,
which requires a signed-in browser session hitting the preview dialog. The
sandbox does not have a bearer token for this project's Supabase.

## What I recommend as the next concrete steps

Order these highest-value → lowest:

1. **Reproduce the 400 with the response body captured.**
   Open Sales → Invoices, click preview on the failing invoice, open
   DevTools → Network, click the failing request to
   `/functions/v1/generate-document`, copy the JSON response body verbatim
   into this doc. That body will name the offending embed/column and end
   the guessing.

2. **Force a PostgREST schema-cache reload.**
   In the SQL editor:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```
   This is idempotent and safe. If the 400 disappears afterwards, the
   root cause was (1) above — a stale schema cache masking real FKs.

3. **Retire `PrintPreviewDialog`'s call to `generate-document`.**
   Replace with an `document_artifacts` reader keyed by
   `document_record_id`. Falls back to `generate-document` only for kinds
   without a worker yet. Delete
   `no-direct-generate-document-in-pages`'s escape hatch once that path
   is gone.

4. **Update the stale comment.**
   `src/services/documents/snapshots/salesInvoice.ts:194-196` claims
   there are no FKs on `invoices`/`invoice_items`. That is no longer true.
   The comment misleads future maintainers into avoiding embeds that
   would actually work.

5. **Add a `PGRST` diagnostics passthrough.**
   `fetchInvoice`/`fetchEstimate`/etc. currently swallow the PostgREST
   error and throw `Invoice not found: <msg>`. When PostgREST returns
   `PGRST200` the message is diagnostic — surface it in the 400 response
   body so the client toast is actionable (right now the preview modal
   shows a generic "print failed" toast without the underlying reason).

None of these are code changes I can make without either the reproduced
400 body (item 1) or a schema-cache reload (item 2), because the fix
directly depends on which one is true.

## What I did not change this turn (and why)

- I did **not** create `useDocumentPrint`. The canonical seam already
  exists as `fetchAndBuild… → ensureDocumentRecord → submitDocumentIntent`
  and every Sales page already uses it verbatim. Adding a hook wrapper
  would be net-negative churn.
- I did **not** patch `PrintPreviewDialog`. Its removal is a scoped
  refactor with real UX surface (Email/SMS/download buttons live in it),
  and doing it in the dark — without confirming which path 400s and why
  — risks a regression in a component that ~30 pages depend on.
- I did **not** modify `generate-document`. The 400 is data-driven, not
  code-driven; blind edits without the reproduced error body are exactly
  the "defensive fallback" pattern you rejected.

If you can capture the 400 response body and paste it into a follow-up
message, I will complete steps (3), (4), (5) in one pass with certainty
about the root cause.
