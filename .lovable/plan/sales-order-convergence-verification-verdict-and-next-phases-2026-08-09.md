# Sales Order convergence — verification verdict and next phases

Roadmap source: `.lovable/plan/sales-order-architecture-audit-verdict-and-convergence-plan-2026-08-09.md`.
Domain invariants: `mem/features/sales-order-lifecycle.md`.

## Phase 1 — independent verification of the previous engineer's claims

Checked directly against the live database and the codebase (not taken on trust).

**Confirmed true.** Every RPC the previous engineer claimed exists, exists with the described
signature: `create_sales_order_atomic(header, items, user)`, `update_sales_order_atomic`,
`set_sales_order_approval_state_atomic(so, action, user, notes)`, `cancel_sales_order_atomic`,
`create_delivery_from_sales_order_atomic`, `confirm_sales_order_atomic`,
`convert_so_to_invoice_atomic`, `release_sales_order_reservations_atomic`,
`resolve_sales_exchange_rate`. Both ledger views (`so_line_balances`, `so_backorder_lines`)
exist. The delivery-route lock trigger `trg_lock_so_on_dn_invoice` exists on `delivery_notes`.
The revenue trigger is correctly gated on the real status vocabulary
(`confirmed, processing, partial, fulfilled`) and clears forecast rows once invoiced.
The `get_next_so_number` two-overload situation is a thin delegate, not a second engine.

**Claim that is false — this is the headline finding.** Phase 6 claims "no client status
writes" and its test passes, but the Sales Orders list still performs client status writes
through the hook:

- `src/pages/SalesOrders.tsx:749` — `updateSalesOrder(order.id, { status: "confirmed" })`
- `src/pages/SalesOrders.tsx:761` — `updateSalesOrder(order.id, { status: "cancelled" })`

`useSalesOrders.updateSalesOrder` (`src/hooks/useSalesOrders.ts:245`) is a generic
`sales_orders.update(dbUpdates)` passthrough, so any column — including `status`, totals and
`is_locked`-adjacent fields — can be written from the browser. Consequences:

- Confirming from the list skips `confirm_sales_order_atomic`, so **no stock reservations are
  created** while the order reads as confirmed.
- Cancelling from the list skips `cancel_sales_order_atomic`, so reservations are not released,
  crossdock links are not broken, pending delivery notes are not cancelled, backorders are not
  closed, `quantity_cancelled` is not written and no audit row is produced — and the RPC's
  refusal to cancel invoiced/delivered orders is bypassed entirely.

The governance test is a **false green**: it only matches a literal `.update({ status: ...})`
within 500 characters of `.from("sales_orders")`, so a call routed through the hook is invisible
to it.

**Second gap — the guard is client-side only.** Unlike proforma invoices (which have a trigger
blocking direct status writes plus `set_proforma_status_atomic`), `sales_orders` has **no
database trigger rejecting direct status transitions**. A grep test in the frontend repo is not
an invariant. Triggers present today cover locking, delete-status, business match, revenue,
crossdock and SMS — none owns the transition itself.

**Third gap — no SQL tests.** `supabase/tests/` contains no sales-order test file at all, so
none of the Phase 6 database invariants are actually proven.

**Not verified (blocked, not failed).** The Vitest suite could not be executed in this session
because node modules are not installed and plan mode forbids state-changing commands. Running
it is the first step of execution.

**Revised verdict by area.** Creation, editing, approval, cancellation, the quantity ledger, FX
capture and derived backorders: correct, and DB-owned. Status transition governance:
*dangerous* — a bypass path is live in production UI. Test coverage: *incomplete and
misleading*. Repeat invoicing and the CSV import path: unchanged, still pending as previously
logged.

## Phase 2 — corrected plan

### Milestone A — close the live bypass (do first)

1. Route the list actions to the canonical engines: `onConfirm` calls `confirmSalesOrder`
   (already exported, wraps `confirm_sales_order_atomic`), `onCancel` calls the atomic cancel
   path with its reason prompt.
2. Narrow `updateSalesOrder` so it cannot write governed columns. It keeps serving benign
   header edits (notes, expected date, reference) and rejects `status`, `is_locked`, totals,
   `converted_invoice_id`, `exchange_rate` and every ledger column; structural edits continue to
   go through `update_sales_order_atomic`.
3. Replace client-side draft deletion with cancellation-as-compensation, keeping deletion only
   for never-confirmed drafts as the DB delete trigger already allows.

### Milestone B — make the invariant a database invariant

4. A `BEFORE UPDATE` trigger on `sales_orders` rejects any status change not made by the owning
   RPCs (same pattern proven on proforma invoices), and rejects client writes to
   trigger-maintained ledger and lock columns. This makes the bypass impossible rather than
   merely discouraged.

### Milestone C — prove it (Phase 6, properly)

5. Fix the false-green test so it follows hook call sites, not just literal query blocks, and add
   a case for each bypass discovered above.
6. SQL tests under `supabase/tests/sales_order_lifecycle_test.sql`:
   concurrent creation cannot duplicate `so_number`; the two invoicing routes together cannot
   exceed ordered quantity; cancelling an invoiced or delivered order fails; a return records
   returned quantity without reducing `quantity_fulfilled`; `update_sales_order_atomic` refuses
   to remove or under-run a delivered or invoiced line; a direct client status write is rejected.

### Milestone D — previously logged remainder

7. Make `convert_so_to_invoice_atomic` repeatable against `quantity_open_to_invoice`; record the
   decision on repeat order-route invoicing in an ADR.
8. Point the CSV import path at `create_sales_order_atomic` and delete the second client-side
   totals implementation.
9. Retire the legacy `backorders` table once reads are proven unused.

## Technical notes

- Files touched in Milestone A: `src/pages/SalesOrders.tsx`, `src/hooks/useSalesOrders.ts`.
- Milestone B is one migration; grants stay `authenticated` + `service_role`.
- No new engine is introduced anywhere — every change removes a competing path or hardens an
  existing canonical one.
