# Purchases & Accounts Payable — Bills Domain: Authoritative Status

Last updated: 2026-08-10. Source audit: `.lovable/plan/purchases-accounts-payable-bills-domain-audit-2026-08-10.md`.

## Domain contract (do not drift from this)

- A **Bill** recognises a liability from a supplier invoice. Employee/cash spend stays in **Expenses**.
- Inventory moves at **Goods Receipt (GRN)** only. Bill posting never touches stock.
- **Overdue is derived, never stored.** No trigger, no status value written by clients.
- Money KPIs come from **`useApSummary`** (ledger-canonical), never from client-side sums.
- `purchase_order_items.quantity_billed` has a **single writer**: the server sync trigger.
- Match state has a **single writer**: `match_bill_atomic`. Clients never write `bill_grn_matches`.

## Completed and verified

| Step | Scope | State |
| --- | --- | --- |
| 0 | Build repair — `"submitted"` added to the `AuditAction` union | Done |
| 1 | Duplicate vendor invoice prevention (`trg_bills_unique_vendor_invoice_number`) + friendly warnings on the create page **and** the edit page (self-excluded) | Done |
| 2 | Approval gate: `submitted` / `approved` statuses, `submit_bill_atomic`, `approve_bill_atomic`, SoD enforced server-side | Done |
| 2b | Overdue derived: `trg_bill_overdue_check` and `mark_overdue_bills` dropped, existing rows backfilled to `received` / `partial`, `billStatus.ts` helpers consumed by the list, record view and dashboard | Done |
| 3 | Matching consolidated into `match_bill_atomic` (also populates `bill_grn_matches`), legacy `match_bill_to_grn` retired, matching runs automatically inside `submit_bill_atomic`, `resolve_bill_match_exception_atomic` for SoD-guarded accept/reject, Match column + `BillMatchPanel` in the UI | Done |
| 4 | `convert_po_to_bill_atomic` bills **received** quantities, not ordered. Live drift check returned 0 rows | Done |
| 5 | AP KPIs from `useApSummary`; **server-side pagination for the Bills list** (`useBillsPaginated`, `DataTablePagination`, `useBills` capped to a 500-row working set) | Done |

### Architecture ratchets in place

`src/test/architecture/`:
- `bill-match-single-writer.test.ts`
- `bill-overdue-derived.test.ts`
- `ap-kpis-canonical.test.ts`
- `po-billed-quantity-single-writer.test.ts`
- `bills-list-pagination.test.ts`

All green, typecheck clean.

## Currently active

Nothing in flight. Step 5 closed with the pagination work; the domain is at a coherent, production-ready state.

## Next milestone — Step 6: vendor credit and debit notes against bills

Rationale: the AP liability side is now complete for the happy path (bill → match → approve → pay), but there is no first-class way to reduce a recognised liability. Returns to suppliers and pricing corrections currently have no AP counterpart, which is the largest remaining gap versus the AR side (credit notes exist there already).

Scope sketch:
1. Read the AR credit-note implementation (`.lovable/plan/credit-notes-audit-findings-and-completion-plan-2026-08-09.md`) and mirror its posting model, not its UI.
2. Server-side atomic issue/apply RPCs; allocation against open bills; never mutate `bills.total`.
3. `useApSummary` must net vendor credits so KPIs stay canonical.
4. Ratchet: no client-side allocation writes.

## Instructions for the next agent

1. **Verify before you build.** Confirm each "Done" row above against the live database and the source, not against this document. Specifically: check that `match_bill_to_grn` no longer exists, that no trigger writes an `overdue` status, that `quantity_billed` drift is still 0, and that `src/pages/Bills.tsx` renders only paged rows.
2. Run the full architecture suite (`src/test/architecture/`) plus a typecheck; treat any failure as a regression in the work above, not as a flaky test.
3. Only then start Step 6. Do not open unrelated areas of the system, and do not leave a phase half-built — each step must reach a coherent, shippable state before the next begins.
4. Update this file the moment a step changes state.

### Known non-code issue

Deploys have been failing with an S3 `AccessDenied` on asset upload. That is infrastructure, not source. Do not attempt code fixes for it.
