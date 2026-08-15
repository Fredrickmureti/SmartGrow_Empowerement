# Sales Domain Wave — authoritative status

Detailed per-phase evidence lives in `docs/plans/sales-domain-live-status.md`.
This file is the wave-level snapshot: what is done, what is pending, what is
active, and what the next agent does first.

## Fully implemented and verified

| Phase | Outcome |
|---|---|
| 0 | Upstream contracts verified against the live database (not migrations). |
| 1 | Sales lifecycle / document graph, immutability and reversal map. |
| 2 | Products reach Sales only through `list_products_with_branch_stock`. |
| 3 | Line quantity contract — `resolve_line_base_quantity`, base units canonical. |
| 4 | Pricing, line tax and totals resolved server-side; header totals rewritten from lines. |
| 5 | Availability policy (`salesStockPolicy`) consumed by every line-capturing editor. |
| 6 | Invoice ↔ Receivables: governed writes, server GL resolution, atomic idempotent creation. |
| 6b | Fulfilment warehouse recorded on invoice / sales order / delivery note; availability read from that same warehouse. |
| 7 | Sale-time tax — `resolve_sales_line_tax` is the single authority; client is preview-only. |

## Independent verification of the previous agent's claims (this session)

Read from the live database (`pg_proc`, `pg_trigger`, `information_schema`),
not from migration files.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 7 tax resolver exists | ✅ confirmed | `resolve_sales_line_tax(p_business_id, p_product_id, p_contact_id, p_date, p_tax_rate_id, p_requested_rate)` present; `_totals_normalize_line()` present and wired via `trg_zz_pricing_normalize_*` on invoice / SO / estimate lines. |
| Invoice creation is atomic + idempotent | ✅ confirmed | `create_invoice_atomic(p_header, p_items, p_user_id, p_idempotency_key)`; `public.sales_document_idempotency` exists with `(business_id, document_type, idempotency_key) → document_id, response`. |
| Invoices and sales orders are governed writes | ✅ confirmed | `trg_00_invoices_governed_write`, `trg_00_sales_order_governed_write`. |
| Phase 9 (estimates) still open | ✅ confirmed pending | **No** `trg_00_estimates_governed_write`; no `create_estimate_atomic` / `update_estimate_atomic`. `EstimateEditPage.tsx` (lines 316–333) and `useEstimates.ts` (191, 269–277) delete-then-insert `estimate_items` straight from the browser. |
| Phase 10 (idempotency) still open | ✅ confirmed pending | `create_sales_order_atomic(p_header, p_items, p_user_id)` takes **no** idempotency key; `convert_estimate_to_invoice_atomic` and `convert_estimate_to_so_atomic` likewise. Only invoice creation is protected. |

No previously-claimed phase was found to be falsely marked complete.
Two additional defects surfaced during verification and are folded into the
phases below:

- **D1 — estimate lines are not transactional.** Browser edit does
  `delete … where estimate_id` then `insert`; a failure between the two leaves
  an estimate with zero lines while the header still shows totals.
- **D2 — conversion paths bypass idempotency.** Estimate → invoice and
  estimate → sales order are one-click server RPCs with no key, so a
  double-click or retry can create two downstream documents from one estimate.

## Currently active phase

**Phase 9 — governed writes and atomic lifecycle for estimates.**

## Pending work, in roadmap order

1. **Phase 9 — estimate lifecycle (active).**
   - `trg_00_estimates_governed_write` + a matching guard on `estimate_items`
     and `estimate_additional_costs`, mirroring the invoice/SO pattern: direct
     browser DML is refused; only the writer RPCs may mutate.
   - `create_estimate_atomic(p_header, p_items, p_costs, p_user_id, p_idempotency_key)`
     and `update_estimate_atomic(...)` performing header + lines + additional
     costs in one transaction, reusing `resolve_line_base_quantity`,
     `_totals_normalize_line` and `resolve_sales_line_tax` (no new engines).
   - Rewrite `useEstimates.ts` and `EstimateEditPage.tsx` to call the RPCs;
     delete the direct `estimate_items` insert/delete paths (fixes D1).
   - Immutability: once an estimate is accepted/converted, lines are frozen —
     enforced by the governed-write trigger, not by the UI.
   - Guard test `estimate-governed-write.test.ts`: no `from("estimate_items")`
     / `estimate_additional_costs` mutation outside the writer seam.

2. **Phase 10 — server authority & concurrency.**
   - Add `p_idempotency_key` to `create_sales_order_atomic`,
     `convert_estimate_to_invoice_atomic`, `convert_estimate_to_so_atomic` and
     the delivery-note creator, all recording through
     `public.sales_document_idempotency` (same insert-on-conflict-return-cached
     shape `create_invoice_atomic` already uses) — fixes D2.
   - Client generates the key once per form instance (not per click), so
     double-click, refresh-and-resubmit and network retry return the first
     document rather than creating a second.
   - Row-level locking on conversion sources (`select … for update` on the
     estimate/SO) so two users converting the same document serialise.
   - Guard test + live probes: double-submit, retry, refresh, two-user edit.

3. **Phase 11 — multi-tenant / branch scope audit**, including document
   numbering: confirm every Sales writer stamps `organization_id`,
   `business_id`, `branch_id` server-side from the session resolver (never from
   the client payload), and that number allocation is unique per
   business+branch+series under concurrency.

4. **Phases 12–14** — business events on `business_event_outbox` for the Sales
   lifecycle (order confirmed, delivery confirmed, invoice issued, credit note
   issued), failure semantics for outbox consumers, and the
   reporting-vs-transactional read-model boundary.

5. Carry-overs: route the manual product picker through the ADR 0114 identity
   seam; `process-recurring-invoices` still writes `next_run_date` itself.

## Working rules for this wave

1. Verify against the live database, never against `supabase/migrations/**`
   (known stale).
2. Consume canonical engines (`convert_uom`, `resolve_product_identity`,
   `resolve_product_price`, `resolve_sales_line_tax`, `reserve_stock_atomic`,
   accounting posting). Never add a Sales-local duplicate.
3. Never work around an upstream defect inside Sales: fix it in its owning
   domain, or mark the phase blocked with evidence.
4. Update `docs/plans/sales-domain-live-status.md` **and** this file at the end
   of every phase, with evidence and the verification commands run
   (`bunx vitest run src/test/architecture`, `bunx tsgo --noEmit -p tsconfig.app.json`).
