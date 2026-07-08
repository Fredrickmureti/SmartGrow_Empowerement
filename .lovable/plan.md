
# Physical Count — Enterprise Hardening (continuation)

Prior turn shipped the D2 lifecycle RPCs (`physical_count_create/record_line/freeze/submit/approve/post/cancel/request_recount/supersede`), D4 reservation soft-locks, mirror-sign reversal via `physical_count_supersede`, and a workspace + detail UI. Architecture guards pass. Below is what remains to reach SAP/Oracle/Odoo parity while staying country-agnostic.

## Gaps found in verification

1. **No Segregation of Duties enforcement.** `physical_count_submit → approve → post` don't check that submitter ≠ approver ≠ poster, and don't consult `self_action_policy` / `self_action_overrides`. Any single user can drive a count from freeze to posted.
2. **Tolerance flagging exists but doesn't gate approval.** `_apply_tolerance_flags` marks `lines.status='over_tolerance'`, but `physical_count_approve` and `physical_count_post` don't block or require justification when flagged lines remain uncleared (recount / override).
3. **No approval-rule integration.** `approval_rules` / `approval_requests` are not consulted for high-value variance thresholds — unlike stock adjustments, which route through `apply_or_request_stock_adjustment`.
4. **Fiscal period + GL account preflight missing.** `physical_count_post` will raise deep inside `post_journal_entry_atomic` if the period is closed or the shrinkage/surplus accounts aren't mapped. No user-facing preflight in the RPC or the UI.
5. **Valuation preview is qty × snapshot cost only.** No FIFO/AVCO layer-level preview; UI shows net impact but not per-account breakdown or the actual JE lines that will be posted.
6. **No cycle-count / ABC scheduler.** `count_type` column exists but there is no recurring cycle-count generator, no ABC classification driver, no "next due" surface — enterprise systems require this.
7. **Cross-module blocking is partial.** Freeze creates soft reservations, but POS `create_pos_sale_atomic`, `confirm_invoice_and_release_stock_atomic`, and `receive_goods_atomic` do not check for a *frozen* physical count on the affected warehouse/product; they'll compete with the reservation and can succeed silently in edge cases.
8. **Legacy shim still callable.** `apply_physical_count_atomic` remains as a public RPC. It should either be dropped or made a hard-error stub to prevent regressions.
9. **UI gaps in workspace/detail.**
   - No "Financial impact preview" modal showing the exact JE the post will produce (per account, per line).
   - No tolerance / SoD indicators on the action bar (button is enabled but RPC will reject).
   - No cycle-count schedule surface, no ABC filter, no "counts due" widget on the inventory dashboard.
   - No inline recount workflow (currently only bulk-select "Request recount" — no line-level counter input in review state).
   - No linkage from the ledger drill-down to the reversing JE when `supersede` is used.
10. **Missing pgTAP tests.** `supabase/tests/inventory-adjustment-gl.sql` exists but there is no `physical-count-lifecycle.sql` covering SoD, tolerance gating, reservation release, supersede, and period-closed rejection.

## Deliverables

### Migration `2026-07-08 D5 — SoD, tolerance-gated approval, preflight`
- Add `physical_count_events` rows for every state transition with `actor_user_id` (already partially present — normalize).
- Enforce SoD inside `physical_count_submit/approve/post`: reject if `actor = created_by / submitted_by / approved_by` unless `self_action_overrides` has an active grant for the actor+action. Reuse `has_self_action_override(_user, _action, _entity)` helper (create if absent) rather than duplicating logic.
- `physical_count_approve` and `physical_count_post`: reject when any line status is `over_tolerance` unless (a) an accompanying `p_tolerance_override_reason` is provided AND (b) actor has `physical_count.override_tolerance` permission (new capability).
- Preflight in `physical_count_post`: assert (i) fiscal period for `posted_at::date` is `open`, (ii) `default_accounts` for `inventory_asset`, `inventory_shrinkage`, `inventory_surplus` all resolve for the org/business. Raise a `P0001` with a stable code (`E_PC_PERIOD_CLOSED`, `E_PC_ACCOUNT_MISSING`) so the UI can render actionable messages.
- Emit `approval_requests` when variance value ≥ business-configurable threshold (`inventory_settings.pc_auto_approve_below`). Add table `inventory_settings` if absent (single row per business) — otherwise reuse `businesses.settings jsonb`.

### Migration `2026-07-08 D6 — cross-module freeze awareness`
- New helper `is_product_frozen(_org, _business, _wh, _product) → boolean`.
- Update `create_pos_sale_atomic`, `confirm_invoice_and_release_stock_atomic`, `receive_goods_atomic`, `complete_delivery_atomic`, `create_stock_transfer_atomic`, and `approve_stock_adjustment_atomic` to call the helper and raise `E_PC_WAREHOUSE_FROZEN` (POS treats it as a soft-fail with a manager-override path already implemented via `pos_manager_overrides`).

### Migration `2026-07-08 D7 — cycle count scheduler`
- Table `cycle_count_schedules` (business_id, warehouse_id, abc_class, cadence_days, next_due_at, active).
- Function `generate_due_cycle_counts()` (runnable from a scheduled edge function) that inserts `physical_counts` rows in `draft` state for each due schedule, seeding lines from ABC-classified products only.
- Materialised view `product_abc_classification` (based on 12-mo COGS by product) refreshed nightly.

### Migration `2026-07-08 D8 — retire shim`
- `DROP FUNCTION apply_physical_count_atomic(...) CASCADE;` (all callers already migrated per architecture guard).

### Frontend
- `PhysicalCountDetail.tsx`
  - New "Financial Impact" side panel: fetches previewed JE via new read-only RPC `physical_count_preview_je(count_id)` returning `[{account_id, account_code, account_name, debit, credit}]`. Show per-account totals + expandable per-line breakdown.
  - Action bar: show badges when SoD would block, when tolerance override needed, when period closed, when accounts unmapped — disable the offending action and show a tooltip explaining why (pre-check via `physical_count_preflight(count_id)` new RPC).
  - Inline recount input: for lines flagged `recount_requested`, expose a numeric input that calls `physical_count_record_line` with `p_is_recount := true`.
  - Ledger drill-down: when `state='reversed'` show both the original and reversing JE side by side.
- `PhysicalCountWorkspace.tsx`
  - Filters for `count_type` (full / cycle / spot) and `abc_class`.
  - "Due today" and "Overdue" tabs backed by the cycle-count scheduler.
- `InventoryDashboard.tsx`
  - New KPI card: open counts, overdue cycle counts, unposted variance value.
- Retire the legacy wizard `PhysicalCount.tsx` (523 lines) — replace with a thin creator that calls `physical_count_create` and redirects to `/inventory/physical-counts/:id`. Keep the file as a redirect for one release then delete.

### Tests
- `supabase/tests/physical-count-lifecycle.sql` (pgTAP): SoD rejects same-user submit→approve→post; tolerance flag blocks approve until override; supersede posts mirror-sign JE with `is_reversal=true`; freeze releases reservations on post AND cancel; cross-module POS sale on frozen warehouse rejects.
- `src/test/architecture/physical-count-lifecycle.test.ts`: extend to assert no client calls `apply_physical_count_atomic` (already covered) AND no UI writes to `physical_count_events` directly AND `physical_count_preview_je` is only read from the detail panel.
- `src/test/architecture/inventory-cross-module-freeze.test.ts`: new guard scanning the D6 RPC bodies for the `is_product_frozen` check.

## Sequencing

1. D5 migration + preflight/preview RPCs.
2. Detail page: financial-impact panel, preflight badges, inline recount.
3. D6 migration + cross-module architecture test.
4. D7 scheduler + dashboard/workspace surfaces.
5. D8 shim retirement + legacy wizard removal.
6. pgTAP + architecture tests, then Playwright checklist for staging QA (documented, not executed in sandbox).

## Out of scope

- Multi-warehouse consolidation counts (deferred — needs UX design).
- Manufacturing back-flush interactions (no MRP module active yet).
- Handheld / RF-gun counting flow (hardware track owns this).
