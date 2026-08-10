# Incident report — 409 Conflict on invoice confirmation

## Verdict

Root cause confirmed. The 409 is a duplicate-key violation (Postgres `23505`, which PostgREST returns as HTTP 409) on the delivery-note number unique index. It is a regression introduced by the delivery-numbering migration dated 2026-08-09 02:17 UTC.

Nothing is half-written: the whole confirmation transaction rolls back, so the invoice correctly stays `draft` with no journal entry and no delivery note. Atomicity is intact — the failure is a hard block, not a corruption.

## What actually happens

1. Confirming an invoice with stockable lines calls `confirm_invoice_and_release_stock_atomic` → `_confirm_invoice_core`.
2. Because the invoice has stockable products and no delivery note, the core function allocates a delivery number by calling the **one-argument** overload `get_next_delivery_number(v_inv.organization_id)`.
3. That legacy overload delegates to `get_next_delivery_number(_org_id, NULL)`. The new implementation scans for the highest existing number **filtered to `business_id IS NOT DISTINCT FROM NULL`** — i.e. only delivery notes with no business. There are none, so it always returns `DN-<year>-0001`.
4. The insert writes that number with the invoice's real `business_id`. The unique index `delivery_notes_number_unique (organization_id, business_id, delivery_number)` — created in the same migration — already holds `DN-2026-0001` for that business.
5. Unique violation → transaction aborts → PostgREST 409 → the create page surfaces the generic "Error creating invoice" toast.

Timeline evidence: invoice `INV-2026-00005` confirmed successfully on 2026-08-08 23:29 (produced `DN-2026-2029`), before the migration. Both stuck drafts (`b1a26302…`, `425f9078…`, 2026-08-10) are after it. Stock is not the issue — 500 units on hand, 0 reserved, against a 10-unit line.

## Blast radius

Four live functions still call the broken one-argument overload, and all of them insert delivery notes with a non-null `business_id`, so all four are equally broken for any organization that already has a delivery note this year:

- `_confirm_invoice_core` (invoice confirmation — the reported incident)
- `record_partial_delivery_atomic`
- `create_return_delivery_atomic`
- `create_delivery_from_sales_order_atomic`

`create_delivery_note_atomic` is correct — it passes the business explicitly.

The sales-order allocator (`get_next_so_number`) has the same one-argument delegate shape, but every live caller passes the business and branch, and its unique index is org-scoped, so it is not affected.

## Proposed fix

1. Migration: make the one-argument `get_next_delivery_number(_org_id)` overload safe rather than silently wrong. Two changes, both needed:
   - Change the two-argument allocator to resolve the maximum across the whole organization for the year (numbers stay unique per business, but the sequence no longer restarts inside a business scope that has no rows) — or, preferably,
   - Fix the callers: pass the real `business_id` into the allocator from `_confirm_invoice_core`, `record_partial_delivery_atomic`, `create_return_delivery_atomic`, and `create_delivery_from_sales_order_atomic`, and drop the misleading `NULL`-defaulting one-argument overload so no future caller can reintroduce the bug.
2. Belt-and-braces: have the allocator retry on collision (or derive the number from a scoped sequence) so a stale max never turns into a user-facing 409.
3. Regression test: an architecture/DB test asserting no function body calls `get_next_delivery_number` with a single argument.
4. Recovery: no data repair needed. The two stuck invoices can simply be re-confirmed once the allocator is fixed.

## Technical notes

- Unique index: `delivery_notes_number_unique ON delivery_notes (organization_id, business_id, delivery_number)`, added 2026-08-09.
- Existing numbers for the affected business: `DN-2026-0001`, `DN-2026-2026`…`DN-2026-2029` (the odd 2026-range values come from an earlier numbering variant; the current regex parses them fine, so an org-wide max would yield `DN-2026-2030`).
- Error path in the UI: `InvoiceCreatePage.handleSubmit` → `useInvoicesPaginated.confirmInvoice` → `confirmInvoiceAndPostGL` → RPC. The Postgres message is preserved through `normalizeError`, so the toast text can be made specific without extra plumbing.
