# Sales Domain Wave — authoritative engineering record

Live per-phase ledger: `docs/plans/sales-domain-live-status.md`.
This file tracks the wave-level state and the active phase only.

## Verification verdict (this agent, 2026-08-15)

Independent re-verification of the previous agent's Phase 0–6 claims against
the **live database** (`pg_proc`, `information_schema`) and the codebase:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `resolve_line_base_quantity` is the server quantity authority | ✅ exists, SECURITY DEFINER | `pg_proc` (business, product, display_qty, display_uom, packaging) |
| `resolve_line_unit_price` / `resolve_line_tax_rate` are the price/tax authorities | ✅ exist, SECURITY DEFINER | `pg_proc` |
| `_sales_header_totals_guard` rewrites header totals from lines | ✅ exists | `pg_proc` |
| `build_invoice_je_lines` owns the invoice JE | ✅ exists | `pg_proc` |
| `_confirm_invoice_core` refuses client `p_main_lines` | ✅ signature keeps the legacy arg only | `pg_proc` |
| `create_invoice_atomic(p_header,p_items,p_user_id,p_idempotency_key)` | ✅ exists, SECURITY DEFINER | `pg_proc` |
| `set_invoice_status_atomic`, `link_invoice_journal_entry_atomic`, `_invoices_governed_write` | ✅ all exist | `pg_proc` |
| No Sales editor inserts invoice headers/lines | ⚠ **false for the edit path** | `InvoiceEditPage.tsx:320–365` |
| `create_sales_order_atomic` idempotency | ❌ no `p_idempotency_key` argument (Phase 10 as recorded) | `pg_proc` |

Phase 6 is therefore accepted as substantially complete, with **one
uncorrected defect the plan did not record** (6.4 below) and the Phase 6b
thesis now evidenced rather than assumed.

### New defect 6.4 — invoice *edit* is still a browser transaction

`InvoiceEditPage.handleSubmit` updates the header with **client-computed**
`subtotal/tax_amount/total`, then `DELETE`s all `invoice_items`, then inserts
new ones — three separate browser round-trips. A failure or a closed tab
between the delete and the insert leaves a **numbered invoice with zero
lines**; there is no row-version check, so two concurrent editors silently
last-write-win. The Phase 4 totals guard repairs the totals afterwards, which
masks the money defect but not the lost-lines or concurrency defect.
Creation was made atomic in 6.2; the edit path was not.

### Phase 6b thesis — Sales never chooses a warehouse (evidenced)

- **No Sales document carries a warehouse.** `information_schema.columns`:
  `invoices`, `sales_orders`, `delivery_notes`, `estimates`, `credit_notes`,
  `proforma_invoices`, `sales_returns` all have `branch_id` and **no
  `warehouse_id`**.
- **`confirm_sales_order_atomic` guesses one**: first active, non-in-transit
  warehouse in the branch `ORDER BY is_default DESC LIMIT 1`. If none matches
  it **skips reservation entirely and still returns `success: true`** with
  `warehouse_resolved: false` — a customer is promised goods nothing was set
  aside for.
- **The invoice path passes nothing**: `confirmInvoiceGL.ts:63` sends
  `p_warehouse_id: null` to `confirm_invoice_and_release_stock_atomic`.
- **Availability and reservation disagree by construction**: the editor badge
  comes from `list_products_with_branch_stock` → branch-aggregate stock, while
  the reservation is taken from one guessed warehouse. In a two-warehouse
  branch a line can read "in stock" and reserve nothing.
- The canonical resolvers already accept the missing argument —
  `resolve_stock_availability(_batch)(… p_warehouse_id …)` and
  `reserve_stock_atomic(… p_warehouse_id …)` — so this is a **wiring and
  persistence gap in Sales, not a missing Inventory engine**.

## Verified complete

- **Phase 0–2** — upstream contract verification, lifecycle reconstruction,
  Product consumption (no Sales-local product tables; single server read seam).
- **Phase 3 — UoM & packaging.** `resolve_line_base_quantity` + triggers on all
  five Sales line tables.
- **Phase 4 — pricing / tax / totals.** `resolve_line_unit_price`,
  `resolve_line_tax_rate`, `_sales_header_totals_guard`.
- **Phase 5 — availability.** Every line-capturing editor consumes
  `useSalesLineAvailability`, guarded by
  `src/test/architecture/sales-availability-coverage.test.ts`.
- **Phase 6 — invoice ↔ receivables.** 6.0 shared stock-eval type, 6.1
  server-side GL resolution, 6.2 atomic idempotent creation, 6.3 governed
  invoice writes. Re-verified above.

## Active milestone — Phase 6b: warehouse is a first-class Sales decision

Principle: Sales does not compute stock and does not own warehouses, but it
**must record which stock location it committed against**. The warehouse is a
document fact, resolved and validated server-side, never guessed at confirm
time and never chosen in the browser.

**6b.1 — persistence.** Migration adds `warehouse_id uuid REFERENCES
public.warehouses(id)` to `sales_orders`, `invoices` and `delivery_notes`
(the three `commit`-policy documents in `salesStockPolicy.ts`). Estimates,
proformas, credit notes and returns are untouched — advisory/none policy.

**6b.2 — one resolver.** `resolve_sales_warehouse(p_organization_id,
p_business_id, p_branch_id, p_requested_warehouse_id)`: returns the requested
warehouse when it is active, non-in-transit and belongs to that
business/branch; otherwise the branch default; **raises** when the branch has
no usable warehouse. Fail-closed, tenant-checked, `SECURITY DEFINER`,
`search_path = public`. This is the only place a Sales warehouse is chosen.

**6b.3 — creation stamps it.** `create_invoice_atomic` and
`create_sales_order_atomic` read `warehouse_id` from `p_header` and stamp the
resolver's answer. A caller that supplies an out-of-branch warehouse is
rejected, not silently corrected.

**6b.4 — confirmation consumes it, and stops lying.**
`confirm_sales_order_atomic` reserves against the stamped warehouse
(re-resolving only when the column is null, for pre-existing rows) and
**returns `success: false` when no warehouse can be resolved** instead of
confirming with zero reservations. `confirmInvoiceGL.ts` passes the invoice's
`warehouse_id` instead of `null`. Governed-write guards add `warehouse_id`
to the reject list once the document leaves draft.

**6b.5 — availability is asked the same question that is answered.**
`useBranchScopedProducts` gains an optional `warehouseId` forwarded to the
server resolver, and `useSalesLineAvailability` consumers pass the document's
warehouse. Still one server number; no client aggregation.

**6b.6 — UI.** A warehouse field in the Sales Order, Invoice and Delivery Note
editors: defaulted from the branch default, hidden when the branch has exactly
one warehouse, read-only once the document is confirmed/posted. Presentation
only — no fallback selection logic in React.

**6b.7 — guard.** `src/test/architecture/sales-warehouse-selection.test.ts`:
every `commit`-policy editor supplies a warehouse; no Sales file passes
`p_warehouse_id: null`; no Sales file queries `warehouses` to pick one.

Every function-defining migration ends with `NOTIFY pgrst, 'reload schema';`
(the compensation-writer-monopoly guard depends on it).

## Then, in roadmap order

1. **Phase 6.4 — `update_invoice_atomic`** (newly added, see defect above):
   header + line replacement in one server transaction, draft-only,
   optimistic-concurrency checked, reusing `sales_document_idempotency`;
   `InvoiceEditPage` becomes a thin caller. Same treatment audited for the
   Sales Order and Estimate edit pages.
2. Phase 7 — sale-time tax resolver ownership in the Tax domain.
3. Phase 9/10 — governed write path for estimates; idempotency across the
   remaining Sales RPCs (`create_sales_order_atomic` first).
4. Phase 2 follow-up — manual product picker through the ADR 0114 identity
   read seam.

## Known pre-existing failure (not caused by this wave)

`src/test/architecture/recurring-invoicing-single-engine.test.ts` fails: the
`process-recurring-invoices` worker still writes `next_run_date` itself.
Belongs to the recurring-invoicing engine (Phase 8).

## Verification standard

No claim enters this file without evidence from the live database or a passing
guard test. The database holds zero invoices, so trigger-level claims are
evidenced by definitions plus migrated call sites; behavioural proof is
recorded when transactional data exists.
