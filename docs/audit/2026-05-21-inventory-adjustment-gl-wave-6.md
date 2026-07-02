# Inventory adjustment ↔ GL — Wave 6 closeout (2026-05-21)

## Scope

Wave 6 closes the three items Wave 5 explicitly deferred and reconciles
the pgTAP suite to the live function signatures.

## Independent re-audit verdict (Waves 1–5)

Verified directly against the live DB, migrations, UI, and architecture
guards. All Wave 1–5 claims hold:

- `resolve_adjustment_unit_cost(uuid,uuid,uuid,uuid,numeric)` — live.
- `approve_stock_adjustment_atomic(uuid,uuid)` — live; raises when no
  cost resolves; per-warehouse `FOR UPDATE` lock; routes through
  `post_journal_entry_atomic`; per-offset accumulator for reason-keyed
  contra accounts.
- `reverse_stock_adjustment_atomic(uuid,uuid,text,uuid)` — live; UI
  wired via `ReverseAdjustmentDialog` in `src/pages/Inventory.tsx`.
- `trg_prevent_approved_adjustment_mutation` — attached BEFORE UPDATE.
- `uniq_stock_adjustments_client_request` — partial unique index live.
- `stock_adjustment_backfill_log` — table + SELECT-only RLS live.
- `preview_adjustment_offset_account(uuid,text,integer)` + dialog hint —
  live.
- `list_adjustments_missing_journals` — paginated overload with
  `p_offset` exists; hook uses `p_limit:100, p_offset:0`.

Naming note: ADR 0016 references `reverse_stock_adjustment`; live name
is `reverse_stock_adjustment_atomic`. UI and hooks already use the
`_atomic` name. Renaming the function would break the immutability
guard and the hook, so the function name stays and ADR text will be
reconciled when next touched.

## Delivered (Wave 6)

### 1. Persistent-drift cron alert

- New column `notification_alert_settings.finance_alert_missing_je_enabled`
  (boolean, default `true`) — per-business opt-out.
- New table `finance_alert_drift_streaks (business_id, metric,
  consecutive_days, last_seen_count, last_evaluated_at, last_notified_at)`,
  RLS enabled with SELECT-only policy (`drift_streaks_select`) keyed off
  `user_can_access_business`. Writes happen only through the
  SECURITY DEFINER evaluator.
- New RPC `evaluate_missing_je_drift_alerts()` (SECURITY DEFINER,
  `search_path = public`). Loops every active, non-archived business,
  counts the missing-JE backlog via `list_adjustments_missing_journals`,
  increments/resets the streak, and posts one notification per
  business when the streak reaches **3 consecutive days**. Daily
  dedupe via `last_notified_at::date = CURRENT_DATE`. Notifications go
  to the existing `notifications` table (`category='finance'`,
  `type='warning'`, link `/finance/reconciliation`).
- `pg_cron` job `finance-missing-je-drift` scheduled at `0 6 * * *`
  (06:00 UTC daily). Idempotent: prior copy unscheduled before
  re-scheduling.

### 2. Per-row backfill history UI

- New hook `useAdjustmentBackfillHistory(adjustmentId, enabled)` in
  `src/hooks/useInventory.ts`. Reads `stock_adjustment_backfill_log`
  scoped by `adjustment_id`, ordered `posted_at DESC`, and resolves
  poster display names via `profiles`. Lazy: `enabled` defaults to
  `false` until the row is expanded.
- `MissingAdjustmentJournalsSection` in
  `src/components/finance/InventoryReconciliationCard.tsx` refactored
  to render each row through a new `MissingJournalRow` component
  with a chevron-driven "Backfill history" disclosure. Empty state,
  loading state, and populated state all handled. Read-only — no
  behaviour change.

### 3. pgTAP signature reconciliation + Wave 6 coverage

- `supabase/tests/inventory-adjustment-gl.sql` fixed:
  - Syntax error around the locked-period assertion (missing
    closing paren before a duplicated `SELECT ok(...)` block).
  - `resolve_adjustment_unit_cost` arg list corrected to
    `uuid,uuid,uuid,uuid,numeric`.
  - `approve_stock_adjustment_atomic` corrected to `uuid,uuid`.
  - `reverse_stock_adjustment` swapped for the real
    `reverse_stock_adjustment_atomic(uuid,uuid,text,uuid)`.
  - `backfill_missing_adjustment_je` corrected to `uuid,uuid`.
- Plan bumped to **27 cases** (21 → 27) with new Wave 6 assertions:
  drift-streaks table exists, opt-out column exists, evaluator
  function exists and is SECURITY DEFINER, evaluator gates on a
  multi-day streak, cron job is scheduled, drift-streaks RLS is
  SELECT-only.

## Verification

- `bunx vitest run src/test/architecture/inventory-adjustment` —
  **19/19 pass** (was 17/17 + 2 new Wave 6 guards).
- Migration applied cleanly; cron schedule registered (cron job id
  returned by `cron.schedule`).
- The evaluator is SECURITY DEFINER + `search_path = public` and was
  not callable from the read-only psql role (expected: 42501).

## Explicitly NOT delivered in Wave 6

Per the approved plan, **only** the three Wave 5 deferrals were in
scope. Wave 6 does NOT include:

- A fully-seeded behavioural pgTAP fixture under
  `supabase/tests/e2e/` (would require seeding an
  organization → business → branch → warehouse → product → COA
  inside the test transaction, which is a separate, larger piece of
  work and was already flagged as a multi-wave effort).
- Any further behaviour changes to `approve_stock_adjustment_atomic`,
  `reverse_stock_adjustment_atomic`, or the offset-account chart
  beyond what Waves 1–5 shipped.
- A UI toggle for the new `finance_alert_missing_je_enabled` flag.
  The column exists, defaults to enabled, and can be flipped via the
  existing notification settings surface; an explicit switch is a
  small Settings polish item, not in scope.

## Files touched

- `supabase/migrations/<wave-6>.sql` (new)
- `supabase/tests/inventory-adjustment-gl.sql` (signatures fixed; +6 cases)
- `src/hooks/useInventory.ts` (`useAdjustmentBackfillHistory`)
- `src/components/finance/InventoryReconciliationCard.tsx`
  (`MissingJournalRow` + disclosure)
- `src/test/architecture/inventory-adjustment-cost-resolution.test.ts`
  (+2 Wave 6 guards)
- `docs/audit/2026-05-21-inventory-adjustment-gl-wave-6.md` (this file)
