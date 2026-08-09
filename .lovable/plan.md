# Sales Order convergence — live status (authoritative)

Roadmap source: `.lovable/plan/sales-order-architecture-audit-verdict-and-convergence-plan-2026-08-09.md`.
Domain invariants: `mem/features/sales-order-lifecycle.md`.

## Completed and verified

**Phase 1 — governance holes closed (DB-owned).**
- Status vocabulary extended (`pending_approval`, `approved`, `rejected`); `trg_sales_order_to_revenue` gated on the real vocabulary (`confirmed, processing, partial, fulfilled`).
- `cancel_sales_order_atomic` owns cancellation: state guards, reservation release, crossdock break, pending-DN cancellation, backorder closure, audit row — one transaction. Client status write deleted.
- `lock_sales_order_on_dn_invoice` closes the post-invoice mutability hole on the delivery-spawned route.
- Unique index `sales_orders_org_number_uniq (organization_id, so_number)`.
- `release_sales_order_reservations_atomic` fixed to filter `released_at IS NULL`.

**Phase 2 — one creation engine.**
- `create_sales_order_atomic(header, items, user)` mints the number, inserts header + lines, derives totals server-side, captures FX. `useSalesOrders.createSalesOrder` repointed; no client totals, no client-minted number.
- `get_next_so_number` and its advisory lock scoped strictly to `organization_id` (matches the unique index).
- `resolve_sales_exchange_rate` added; lead → SO and estimate → SO conversions fixed (branch, salesperson, tax, payment terms, FX).

**Phase 3 — quantity ledger.**
- `sales_order_items.quantity_invoiced` / `quantity_cancelled`; `invoice_items.sales_order_item_id` / `delivery_note_item_id` provenance (backfilled).
- Trigger-maintained billed quantity (`trg_so_item_invoiced_qty`, `trg_invoice_status_so_ledger`); `_so_write_cancelled_quantities` closes the ledger on cancel.
- `so_line_balances` view is the canonical ordered / delivered / invoiced / returned / cancelled / open ledger. Both invoicing routes populate line provenance and carry the order's FX rate.

**Phase 4 — provenance.** `exchange_rate` on `sales_orders`, carried to invoices on both routes; conversion data loss fixed. Remaining gap: `estimates` has no `salesperson_id` / `shipping_address` columns, so those cannot be carried from an estimate (terms are preserved in notes).

**Phase 5 — duplicate engines removed.**
- `create_delivery_from_sales_order_atomic` owns SO → delivery note (numbering, state guards, quantity validation).
- `so_backorder_lines` derives backorder demand from the ledger; `useBackorders` is read-only and the legacy `backorders` table is client-write-revoked. `BackorderWidget` reads derived demand.
- `useSalesOrderLineBalances` is the single client reader of `so_line_balances`.

**Phase 5.5 — edit and approval become DB-owned** (this milestone).
- `update_sales_order_atomic`: updates surviving lines **in place** (preserves `quantity_fulfilled` / `quantity_invoiced` and invoice/delivery provenance), refuses edits on locked/invoiced/cancelled/fulfilled orders, refuses removing or under-running a line that already moved, recomputes totals server-side. `SalesOrderEditPage` no longer deletes and re-inserts lines.
- `set_sales_order_approval_state_atomic(so, action, user, notes)`: guarded `submit` / `approve` / `reject` with audit rows. `useSalesOrderApproval` no longer writes `sales_orders.status`; approve still chains `confirm_sales_order_atomic` so reservations are created.

**Phase 6 (partial) — architecture guards.** `src/__tests__/architecture.sales-order-governance.test.ts` — 10 tests green: no client status writes, no client inserts into `sales_orders` / `sales_order_items`, no ledger-column writes, atomic RPCs in use, edit path uses `update_sales_order_atomic`, approval path uses the approval RPC, ledger read from `so_line_balances`, backorders derived, status vocabulary legal (with `approval_requests` lifecycle distinguished).

## Active phase

**Phase 6 — lock the verdict in tests.** Client-side guards done; SQL tests not yet written.

## Next milestone (do this next, in order)

1. SQL tests under `supabase/tests/` for the invariants Phase 6 promises:
   - concurrent `create_sales_order_atomic` cannot duplicate `so_number`;
   - the two invoicing routes together cannot exceed ordered quantity;
   - cancelling an invoiced or delivered order fails;
   - a return does not reduce `quantity_fulfilled` (it records returned quantity);
   - `update_sales_order_atomic` refuses to remove or under-run a delivered/invoiced line.
2. Phase 3 remainder: make `convert_so_to_invoice_atomic` repeatable against `quantity_open_to_invoice` (today it bills the open quantity but still locks the order to a single invoice). Decide explicitly whether repeat order-route invoicing is in scope, and record the decision in an ADR.
3. Point the CSV import path at `create_sales_order_atomic` and delete the second client-side totals implementation (Phase 2 residue).
4. Retire the legacy `backorders` table once reads are proven unused.

## Instructions for the next agent

Verify before extending. Do not take this document on trust:
- Run `bunx vitest run src/__tests__/architecture.sales-order-governance.test.ts` and the full suite.
- Confirm in the database that `update_sales_order_atomic`, `set_sales_order_approval_state_atomic`, `cancel_sales_order_atomic`, `create_sales_order_atomic`, `create_delivery_from_sales_order_atomic`, `so_line_balances`, and `so_backorder_lines` exist with the described guards, and that grants are `authenticated` + `service_role` only.
- Exercise the edit path against an order with a delivered line and confirm the ledger survives.

Then resume at "Next milestone" item 1. Stay chronological: finish Phase 6 to a production-ready state before touching the Phase 3 remainder, and do not start unrelated modules.
