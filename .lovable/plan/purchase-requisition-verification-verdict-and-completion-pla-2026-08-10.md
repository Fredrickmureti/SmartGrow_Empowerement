# Purchase Requisition — Verification Verdict and Completion Plan

## What I verified in the database and code (not assumed)

The previous arc's migrations are live. Confirmed against the running schema:

| Plan item | Verified state | Status |
|---|---|---|
| R1 Server authority | `purchase_requisitions` now has split policies (`_read`/`_insert`/`_update`/`_delete`) plus `trg_pr_guard_header` (BEFORE UPDATE/DELETE) and `trg_pr_guard_item` (BEFORE INSERT/UPDATE/DELETE) gated by `_pr_lifecycle_active()` | DONE |
| R2 Canonical approval | `governance_duties` has `requisition.create/submit/approve`; SoD pairs `requisition.approve↔submit`, `↔create`, `po.create↔requisition.approve`; `_mirror_approval_to_requisition` trigger exists | DONE, one gap: `governance_action_registry` holds only `requisition.approve` — `requisition.submit` is not registered |
| R3 Dimensions & line model | Header gained `analytic_account_id`, `destination_branch_id/warehouse_id`, `version`, `approval_request_id`, `submitted_by`; lines gained `destination_*`, `quantity_ordered/received/cancelled`, `is_non_catalog` | DONE |
| R4 Release & traceability | `requisition_create_rfq`, `requisition_convert_to_po` exist; `_pr_recalc` + triggers on `purchase_orders`, `purchase_order_items`, `rfq_items`; over-ordering blocked by `trg_pr_assert_not_overordered`. Receipt rollup rides `purchase_order_items.quantity_received`, which `create_goods_receipt` maintains — the GRN→requisition edge closes | DONE with defects (below) |
| R5 Amend / cancel | `requisition_amend` and `cancel_requisition` exist | PARTIAL — no line-level cancellation and no explicit close |
| R6 Workbench UI | Record page (618 lines) has procurement panel and actions; create page has pickers | PARTIAL — list page is still a flat status dropdown, no operational buckets, no overdue signal, no metrics |
| Tests | No requisition test file exists anywhere; `procurement.test.ts` only mentions requisitions in a comment | PENDING |

## Defects found in shipped code

1. **Dead status branch in `_pr_recalc`.** The header-status CASE has two identical `count(*) FILTER (WHERE status NOT IN ('cancelled','closed')) = 0` arms; the second (`'fulfilled'`) is unreachable, so a fully received requisition reports `closed` and never `fulfilled`.
2. **`procured` is unreachable in mixed states.** The `procured` arm requires every non-cancelled line to be exactly `ordered`; as soon as one line reaches `partially_received`/`closed`, the requisition can never report `procured`. Statuses must be computed from quantity rollups, not from a status-set test.
3. **No `requisition_close` command.** Closing is only implicit via full receipt; a buyer cannot short-close a line ("ordered 60 of 100, stop here"), which is a standard procurement action and the reason `quantity_cancelled` exists but is never written.
4. **`requisition.submit` missing from `governance_action_registry`,** so submission cannot be policy-routed even though the duty and SoD rows exist.
5. **PO cancellation leaves stale rollups.** `_pr_recalc_from_po` fires on `purchase_orders` UPDATE, but `_pr_recalc` counts `po.status <> 'cancelled'` only for ordered quantity while received quantity is summed unconditionally — a cancelled PO keeps contributing received quantity.
6. **Replenishment bypasses the demand domain.** `auto_create_replenishment_po` and `run_replenishment_planning` create POs directly with no requisition, so inventory-origin demand has no authorization record. This is an accepted boundary today, but must be recorded as a deliberate decision rather than an oversight.

## Completion plan

### C1 — Fix the rollup state machine (migration)
Rewrite `_pr_recalc` to derive line and header state from quantities, not status sets:
- line: `open → sourcing → partially_ordered → ordered → partially_received → received → closed/cancelled`, using `quantity_ordered`, `quantity_received`, `quantity_cancelled` against `quantity`.
- header: `approved → sourcing → partially_procured → procured → partially_fulfilled → fulfilled → closed`, with `cancelled` only when every line is cancelled.
- exclude cancelled POs from **both** ordered and received sums.
- keep `closed_at` set only at terminal close.

### C2 — Close and short-close commands (migration)
- `requisition_close_line(_item_id, _reason)` — writes `quantity_cancelled = quantity - quantity_ordered`, guards against closing more than outstanding, re-runs `_pr_recalc`, emits `procurement.requisition.line_closed`.
- `requisition_close(_requisition_id, _reason)` — short-closes every outstanding line, sets header `closed`, emits `procurement.requisition.closed`. Both SECURITY DEFINER, business-scoped, SoD-aware, idempotent by requisition/line + state.

### C3 — Governance completeness (migration)
Register `requisition.submit` in `governance_action_registry` (module `procurement`, subject `purchase_requisitions`) so submission can be policy-gated identically to approval.

### C4 — Requisitions workbench list (UI)
Replace the flat status filter with operational buckets driven by the real status vocabulary: Drafts · Awaiting approval · Approved awaiting sourcing · Sourcing · Partially procured · Partially fulfilled · Overdue (need-by in the past and not fulfilled) · Rejected · Cancelled · Closed. Each bucket shows a count; the table gains ordered/received progress and need-by ageing. Empty state explains the demand→approval→sourcing flow instead of "No requisitions yet".

### C5 — Record page completion (UI)
Expose the short-close actions from C2, per-line outstanding quantity, and the amendment/version trail (version number plus the reason approval was invalidated) alongside the existing procurement panel.

### C6 — Tests
Add `src/test/architecture/requisitions.test.ts` (guards: no client-side status/quantity writes, all lifecycle calls go through `requisitionRpcs.ts`, no free-text currency/cost-centre inputs) and a SQL test in `supabase/tests` covering: draft-only line edits, direct `status` update rejected, over-order rejected, split PO rollup across two POs, receipt rollup, PO cancellation restoring outstanding quantity, short-close, and self-approval refusal.

### C7 — Record the inventory-demand boundary
Document in `docs/audit/` and project memory that replenishment and back-to-back sales demand intentionally create POs directly today, and that routing them through requisitions is a future demand-consolidation phase — not a silent gap.

## Out of scope (unchanged)
No journal entries from requisitions. Budget/encumbrance consumption stays deferred: there is no commitment table, and encumbrance accounting needs its own design pass.
