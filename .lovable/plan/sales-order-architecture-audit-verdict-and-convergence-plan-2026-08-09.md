# Sales Order Architecture Audit — Verdict and Convergence Plan

## What a Sales Order is here (proven, not assumed)

The database proves the intended model, and it matches mature ERP practice (SAP VBAK/VBAP, Odoo `sale.order`, NetSuite SO): the Sales Order is a **commercial commitment**, not an accounting document.

- It posts **no GL**. The only trigger that touches finance from `sales_orders` is `trg_sales_order_to_revenue`, which writes *forecast* rows into `project_revenue_entries` and deletes them once the invoice owns realized revenue.
- Inventory ownership sits at **delivery**, not order. `complete_delivery_atomic` writes `stock_movements`, consumes FEFO lots, snapshots `cost_at_shipment`, and posts the COGS journal via `post_journal_entry_atomic`.
- Stock is **reserved at confirmation** (`confirm_sales_order_atomic` → `stock_reservations`), consumed at delivery (`consume_so_reservation`), restored on return (`restore_so_reservation`), released on cancel.
- Provenance is real: `source_estimate_id`, `source_lead_id`, `project_id`, `invoices.source_sales_order_id`, `delivery_notes.sales_order_id` / `spawned_invoice_id`, plus `get_document_lineage`.

Actual lifecycle in this system:

```text
CRM lead ──► Estimate ──┐
                        ├──► Sales Order ──► Reservation ──► Pick wave / Pack ──► Delivery Note
Direct entry / CSV ─────┘                                                            │
                                                                    ┌────────────────┴─────────────┐
                                                          (A) DN spawns invoice        (B) SO converts to invoice
                                                                    └────────────────┬─────────────┘
                                                                              Invoice ──► Payment ──► GL
Return DN ──► stock reversal + COGS reversal ──► Credit note ──► Customer credit / refund
```

**Verdict: the skeleton is correct and must be preserved.** The failures are at the edges: two invoicing engines, a missing quantity ledger, a broken approval vocabulary, and cancellation/edit governance that lives in the browser instead of the database.

## Findings by severity

### Dangerous — provable defects

1. **The approval workflow cannot work.** `useSalesOrderApproval.ts` writes `pending_approval`, `approved`, `rejected`, but `sales_orders_status_check` only permits `draft, confirmed, processing, partial, fulfilled, invoiced, cancelled`. Every approval write raises a check violation. `confirm_sales_order_atomic` also accepts status `approved` — a branch that can never be reached.
2. **Cancellation is a browser UPDATE, not a business event.** `useSalesOrders.ts` releases reservations, then separately writes `status = 'cancelled'` with no state guard. A `fulfilled` or `invoiced` order can be cancelled, the two steps are not atomic, and open pick waves / crossdock opportunities / pending delivery notes are not compensated.
3. **Post-invoice mutability hole.** `is_locked` is only raised by `lock_sales_order_on_invoice_link`, which fires on `converted_invoice_id`. Invoices spawned from delivery notes never set that column, so those orders stay unlocked and `updateSalesOrder` can still rewrite prices, quantities and the customer after invoicing.
4. **`so_number` has no unique index**, and the number is fetched in one round trip then inserted in another. Worse, the two overloads of `get_next_so_number` take different advisory locks (org-global vs per-branch) and different filters, so concurrent branch and lead-conversion paths can mint the same number.
5. **Order creation is not atomic.** The client inserts the header, then the lines. A failure on the second insert leaves a persisted order with totals and no lines.

### Architectural drift

6. **Two invoicing engines with different semantics.** The delivery-based path (`create_invoice_from_delivery_atomic`) invoices what actually shipped and supports many invoices per order. The order-based path (`convert_so_to_invoice_atomic`) invoices *ordered* quantities, permits exactly one invoice, and blocks itself once any DN has spawned one. The cross-guards prevent double-invoicing, but the order path can over-invoice undelivered goods and permanently forecloses partial invoicing.
7. **No invoiced-quantity ledger.** Lines carry only `quantity`, `quantity_fulfilled`, `quantity_backordered`. Invoiced quantity is re-derived by re-summing sibling delivery notes at every check. Returns *decrement* `quantity_fulfilled` instead of recording `quantity_returned`, so an order silently walks back out of `fulfilled` and the ordered-vs-happened history is compressed into one mutable counter.
8. **Two backorder engines.** `record_partial_delivery_atomic` creates a follow-on delivery note (correct, server-side); `useBackorders.ts` writes a separate `backorders` table and mutates `quantity_backordered` from the browser.
9. **Status vocabulary drift.** `trg_sales_order_to_revenue` gates on `('confirmed','partial','delivered','done')` — `delivered` and `done` are not legal statuses, and the real terminal states `fulfilled` and `processing` are missing, so project forecast revenue is dropped exactly when an order ships.
10. **Conversion loses commercially meaningful fields.** Estimate → SO drops `salesperson_id`, `payment_term_id`, `shipping_address`, and invents `expected_date` as today + 14 days. Lead → SO drops `branch_id` and salesperson, writes tax as 0, and takes currency from the business rather than the lead. `sales_orders` has **no `exchange_rate` column at all** despite a multi-currency setup.
11. **Duplicated rules.** Totals math is implemented twice (create page vs CSV import, with different discount ordering); fulfillment rollups are computed twice; SO → delivery note is still a client-side multi-insert while every sibling conversion is an RPC.

### Correct — preserve unchanged

Delivery-side inventory and COGS, over-delivery caps against both SO and invoice, lot/serial handling, cost snapshotting, reservation lifecycle, return symmetry, lead/estimate conversion idempotency, draft-only delete enforcement, branch/business isolation triggers, `get_document_lineage`.

## Convergence plan (smallest correct set, ordered)

**Phase 1 — close the governance holes (DB-owned).**
- Extend the status vocabulary to include `pending_approval`, `approved`, `rejected`; align `confirm_sales_order_atomic` and fix `trg_sales_order_to_revenue` to the real vocabulary (`confirmed, processing, partial, fulfilled`).
- Add `cancel_sales_order_atomic(p_so_id, p_user_id, p_reason)`: validates cancellable states, releases reservations, unwinds open waves/crossdock, blocks cancellation once anything is invoiced, writes an audit row — all in one transaction. Repoint the UI to it and delete the client-side status write.
- Replace `lock_sales_order_on_invoice_link` with a lock condition that also fires when any delivery note for the order spawns an invoice, so post-invoice edits are impossible on both paths.
- Add a unique index on `(organization_id, so_number)`.

**Phase 2 — one creation engine.**
- Add `create_sales_order_atomic(header jsonb, lines jsonb)` that mints the number, inserts header and lines, and recomputes totals server-side inside one transaction. Point the create page and the CSV import at it, and delete both client-side totals implementations.
- Retire the single-argument `get_next_so_number` overload; require business and branch.

**Phase 3 — the quantity ledger (the core fix).**
- Add `quantity_invoiced`, `quantity_returned`, `quantity_cancelled` to `sales_order_items`, and stop rewinding `quantity_fulfilled` on returns.
- Introduce one SQL function, `so_line_balances(p_so_id)`, as the single source of truth for ordered / fulfilled / invoiced / returned / cancelled / remaining. Every guard and every UI rollup reads it — nothing recomputes quantities locally.
- Rewrite `convert_so_to_invoice_atomic` to invoice **remaining uninvoiced quantity** and to allow repeat invoicing, and have both invoicing paths increment `quantity_invoiced`. This makes the two engines two entry points to one ledger rather than two competing rules.

**Phase 4 — provenance completeness.**
- Add `exchange_rate` to `sales_orders` and carry it through conversion.
- Carry `salesperson_id`, `payment_term_id`, `shipping_address`, and the customer's requested date through estimate → SO; carry `branch_id`, salesperson and tax through lead → SO.

**Phase 5 — remove the duplicate engines.**
- Make the follow-on delivery note the only backorder mechanism; reduce `quantity_backordered` to a derived value from `so_line_balances` and retire the client-side `backorders` writes (keep the table read-only until proven unused).
- Move SO → delivery note creation into an RPC, matching its siblings.

**Phase 6 — lock the verdict in tests.**
- Architecture tests asserting: no client-side status writes to `sales_orders`; no local quantity arithmetic outside `so_line_balances`; every status string in code exists in the CHECK constraint.
- SQL tests: concurrent creation cannot duplicate `so_number`; two invoices cannot exceed ordered quantity; cancelling an invoiced order fails; returning goods does not reduce `quantity_fulfilled`.

## Technical notes

No business semantics change: the Sales Order stays non-accounting, delivery stays the inventory/COGS owner, invoice stays the AR/revenue owner, cancellation becomes compensation instead of a status overwrite. No second engine is introduced — Phase 3 collapses the two existing invoicing paths onto one ledger rather than adding a third. Phases 1–3 are independently shippable; Phase 3 is the only one that requires a backfill (compute `quantity_invoiced` and `quantity_returned` from existing invoice items and return delivery notes).
