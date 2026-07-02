# Inventory adjustment ↔ GL — Wave 5 closeout (2026-05-21)

## Scope

Wave 5 closes the two items Wave 4 explicitly deferred (G2 partial, G6) plus
three new gaps surfaced by the independent re-audit (backfill observability,
missing-JE detector pagination, integrity-panel exposure).

## Delivered

### G6 — Offset-account preview in the adjustment dialog
- New RPC `preview_adjustment_offset_account(business_id, reason, sign)` —
  read-only wrapper around the existing `resolve_adjustment_offset_account`.
  Returns `{account_id, account_code, account_name}` so the dialog can show
  the operator exactly which GL account the chosen reason will hit.
- `src/hooks/useInventory.ts` exposes `useOffsetAccountPreview(reason)`.
- `src/pages/Inventory.tsx` renders a new `<OffsetAccountHint />` directly
  under the reason picker: "Posts contra to **5300 — Inventory Shrinkage**.".
  Pure transparency — no behaviour change.

### Backfill audit trail (new finding)
- New table `stock_adjustment_backfill_log` (organization_id, business_id,
  adjustment_id, journal_entry_id, posted_by, posted_at, total_value, reason,
  note). RLS: SELECT-only for tenants; writes restricted to the
  `SECURITY DEFINER` RPC.
- `backfill_missing_adjustment_je` now writes one audit row per successful
  backfill in the **same transaction** as the JE post. An audit row exists
  iff a JE exists.
- The note column records the original `adjustment_date`, since the backfill
  posts at today's resolved cost (per ADR 0016).

### Pagination on the missing-JE detector
- `list_adjustments_missing_journals` now accepts `p_offset` and defaults
  `p_limit` to 100 (was 500). The hook passes `p_limit: 100, p_offset: 0`.
  Large legacy backlogs no longer fan out into a single 500-row query.

### G2 partial — pgTAP coverage extended
- `supabase/tests/inventory-adjustment-gl.sql` plan bumped to 21 cases (was
  15). Four new source-level / schema-level assertions:
  1. `preview_adjustment_offset_account` exists with the expected signature.
  2. `stock_adjustment_backfill_log` table exists.
  3. `backfill_missing_adjustment_je` references the audit table in its body.
  4. `stock_adjustment_backfill_log` policies are SELECT-only (no tenant
     INSERT/UPDATE/DELETE policies).
  5. `list_adjustments_missing_journals` accepts `p_offset`.

## Verification

- `bunx vitest run` over the four inventory-adjustment architecture guards:
  **20/20 pass** (`inventory-adjustment-posting`, `cost-resolution`,
  `stock-adjustment-rpc-types`, `no-client-stock-adjustment-status-writes`).
- Migration applied cleanly; no new linter findings attributable to this
  wave (the 1543 reported are pre-existing systemic legacy debt).

## Deferred — explicit, to Wave 6

1. **Fully-seeded behavioural pgTAP** (the 6 round-trip scenarios from
   the Wave 5 plan). Source-level guards are in place; building a
   self-contained org/business/branch/warehouse/product/account fixture
   inside pgTAP is a separate, larger piece of work.
2. **Persistent-drift cron alert.** The drift count is surfaced in the
   Accounting Integrity panel (Wave 4) and the reconciliation card. A
   daily `pg_cron` job that pushes a notification when the count stays
   > 0 across N days requires deciding the channel (existing notifications
   table vs finance-alerts queue) and an opt-out setting — out of scope
   for this wave.
3. **Per-row backfill history UI.** The `stock_adjustment_backfill_log`
   rows are queryable today; surfacing them as a collapsible "Backfill
   history" inside each row of `MissingAdjustmentJournalsSection` is a
   UI-only follow-up and was descoped to keep this wave compact.

## Files touched

- `supabase/migrations/<wave-5>.sql` (new)
- `supabase/tests/inventory-adjustment-gl.sql` (+ 6 cases)
- `src/hooks/useInventory.ts` (`useOffsetAccountPreview`, paginated detector)
- `src/pages/Inventory.tsx` (`<OffsetAccountHint />`)
- `.lovable/plan.md` (Wave 5 closeout appended)
- `docs/audit/2026-05-21-inventory-adjustment-gl-wave-5.md` (this file)
