# Returns Domain — Audit Findings and Convergence Plan

## A. Executive verdict

The Returns domain is **two engines, one of them mature, joined by an unguarded seam**.

- **Correct and to be preserved:** the financial reversal chain. `issue_credit_note_atomic` splits the credit between AR reduction and a customer-credit liability based on the invoice's live open balance, reverses tax separately, resolves revenue accounts per line (ADR 0122 ladder), refuses closed periods, asserts no duplicate posting by `(source_type, source_id)`, and posts only through `post_journal_entry_atomic` (ADR 0123). Paid-vs-unpaid is genuinely modelled. Refunds have their own append-only engine (`refund_customer_atomic`, `customer_refunds` with `client_request_id` and approval separation-of-duties).
- **Correct and to be preserved:** the warehouse RMA engine. `wms_return_orders` / `wms_return_lines` implement a real lifecycle (`draft → authorized → in_transit → received → inspecting → disposed → closed / cancelled`), per-line inspection states, eight dispositions, `row_version` optimistic locking, `FOR UPDATE` locking, quarantine holds, task spawning, exception detection, and idempotent finance-document creation.
- **Defective:** the Sales-side `sales_returns` document. It is client-owned, has no quantity ledger, no unique number, a broken number generator, an unenforced state machine, and it restocks stock unconditionally.
- **Dangerous:** the seam between the two engines double-counts inventory (detail below).

## B. Critical findings (evidence-backed)

**1. Double restock across the WMS/Sales seam — Critical.**
`wms_post_return_dispositions` already writes `stock_movements` for restock/quarantine/scrap. `wms_create_return_finance_doc` then inserts a `sales_returns` row in status `pending` carrying `received_qty` and zero prices. When a Sales user approves that row, `approve_sales_return_atomic` writes a **second** `return_in` movement for the same units, into the branch default warehouse, ignoring the WMS disposition — so scrapped and quarantined goods become sellable stock. Nothing marks the row as WMS-sourced or blocks the restock.

**2. Disposition is ignored on the Sales path — High.**
`approve_sales_return_atomic` loops every line with a `product_id` and restocks it, regardless of `sales_return_items.condition` (`good | damaged | defective`). There is no inspection or quarantine step on this path.

**3. Silent GL skip in a closed period — High.**
The COGS/inventory reversal is wrapped in `IF ... AND public.is_period_open(...)`. If the period is closed, stock still moves and the credit note is still created, but no journal entry is posted and nothing raises. Inventory value and the ledger silently diverge. (Compare `issue_credit_note_atomic`, which correctly *raises* on a closed period.)

**4. No quantity ledger; over-return is possible — High.**
`sales_return_items.invoice_item_id` is nullable with no uniqueness or aggregate check. Nothing compares the return quantity against delivered/invoiced quantity, nor against quantities already returned on prior returns. Two returns can each return the full invoice line. The POS path, by contrast, has `v_pos_returnable_qty` — the correct pattern already exists in this ERP.

**5. Numbering is broken and racy — High.**
`get_next_sales_return_number` computes `MAX(regexp_replace(return_number,'[^0-9]','','g'))`, which strips the hyphens and folds the year into the number: `SR-2026-0001` reads as `20260001`, so the next number becomes `SR-2026-20260002`. It is org-scoped (not business/branch-scoped, unlike `get_next_credit_note_number`), there is **no unique constraint** on `sales_returns.return_number`, and the client reads the number then inserts in a separate round trip. The WMS path emits a third format (`SR-YYYYMM-<hash>`), which also poisons the MAX.

**6. Client owns document creation — High.**
`useSalesReturns.createSalesReturn` inserts the header and the items as two separate client statements with client-computed totals; a failed item insert leaves an orphan header. `updateSalesReturn`, `rejectReturn` and `deleteSalesReturn` write `status` and delete rows straight from the browser. There is no idempotency key anywhere on the create path, so a retry mints a duplicate return.

**7. State machine is fictional — Medium.**
The check constraint allows `pending | approved | received | refunded | rejected`, but `received` and `refunded` are never set by any writer, and no transition is enforced in the database — any client update can jump to any state.

**8. Cost basis is approximate — Medium.**
Return unit cost is resolved as "latest `cost_at_shipment` for this product on any delivery note tied to the invoice", not the actual shipped line, and it does not reinstate cost layers (`cost_layers` / `cost_layer_consumptions` exist and are maintained elsewhere). FIFO/FEFO identity is lost on the way back in.

**9. Line-level RLS is weaker than the header — Medium.**
`sales_return_items` is covered by a single permissive `ALL` policy scoped through the parent's `organization_id`, while `sales_returns` and `credit_notes` use business-scoped, branch-scoped, module-permission policies. Line access does not honour branch isolation or delete permissions.

**10. Zero-value credit notes from WMS returns — Medium.**
The WMS-raised `sales_returns` rows carry `unit_price = 0` / `total = 0`; approving one produces a zero-value credit note and no revenue or tax reversal, with no warning.

## C. Convergence plan

The plan preserves every function named in section A unchanged. All new logic is server-side.

**Phase 1 — Stop the bleeding (Critical/High correctness).**
- Add `wms_return_order_id` to `sales_returns`. When set, `approve_sales_return_atomic` skips stock movements entirely (WMS already moved the goods) and posts only the finance legs. Backfill from `wms_return_orders.finance_doc_id`.
- Make the closed-period case *raise* instead of silently skipping the COGS entry, matching `issue_credit_note_atomic`.
- Honour `condition`: only `good` lines restock to sellable; `damaged`/`defective` route to the quarantine/damaged location using the same mechanism the WMS disposition path already uses.
- Verification: pgTAP tests for "WMS-sourced return produces no second movement", "closed period raises", "damaged line does not increase sellable stock".

**Phase 2 — Quantity integrity.**
- Add a `v_sales_returnable_qty` view (invoiced/delivered qty minus already-returned qty per `invoice_item_id`), mirroring `v_pos_returnable_qty`.
- Enforce it inside the create RPC and re-check under `FOR UPDATE` at approval, so concurrent returns cannot jointly over-return.
- Verification: pgTAP concurrency test — two returns of 5 against a returnable 5; the second must fail.

**Phase 3 — Server-owned creation, numbering, idempotency.**
- New `create_sales_return_atomic(_payload jsonb)` doing header + lines + totals + number allocation in one transaction, with `client_request_id` for replay safety. Number allocation moves to the existing business/branch-scoped sequence mechanism used by `get_next_credit_note_number`; the digit-stripping generator is retired.
- Add `UNIQUE (organization_id, return_number)`; align the WMS-raised number to the same series.
- Rewrite `useSalesReturns` to call the RPC. Direct client inserts/updates/deletes on `sales_returns` and `sales_return_items` are removed.
- Add an architecture ratchet next to the existing ones in `src/test/architecture/` banning client writes to these two tables.

**Phase 4 — Lifecycle and cost fidelity.**
- Single `transition_sales_return(...)` RPC enforcing `pending → approved | rejected`, `approved → received → refunded`, terminal `rejected`. Unused states are either wired to real events or dropped from the constraint.
- Return valuation resolves against the actual shipped delivery-note line and reinstates cost layers instead of taking the latest product cost.

**Phase 5 — Security, provenance, reporting.**
- Replace the permissive `sales_return_items` policy with business/branch/module-permission policies matching `credit_note_items`.
- Confirm returns appear as distinct facts (gross sales vs returns vs net) in sales, inventory-valuation and tax reporting, sourced from the credit note and stock movements rather than recomputed.

## D. Technical notes

No new posting engine, credit-note engine, refund engine, numbering mechanism or document pipeline is introduced — every phase routes through the existing canonical ones (`post_journal_entry_atomic`, `issue_credit_note_atomic`, `refund_customer_atomic`, the shared document snapshot pipeline). Changes are additive; the only removals are the broken number generator and the client-side write paths.

**Final verdict:** today the ERP **cannot** safely process the full customer-return lifecycle — the WMS-to-Sales seam duplicates inventory, closed periods drop the COGS entry, and nothing bounds returned quantity. Everything downstream of the credit note is already trustworthy. Phases 1 and 2 close the integrity breaks; Phases 3 to 5 remove the architectural ambiguity.
