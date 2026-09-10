# Fixed Assets — Depreciation Authority: audit, remediation and verification

Date: 2026-09-10. Scope: depreciation calculation and posting authority, plus a
read-only review of the surrounding asset lifecycle.

## 1. Original architecture (as found)

Fixed Assets was a client-side batch job:

- `useDepreciationRun.ts` computed the depreciation amount in the browser, wrote
  `depreciation_schedules` directly, and overwrote
  `fixed_assets.accumulated_depreciation` / `book_value` itself. The amount
  handed to the ledger was whatever the browser decided.
- Duplicate protection was a browser-side "check then insert"; two concurrent
  runs could both pass it.
- `supabase/functions/run-depreciation` was a **second, divergent engine** using
  transaction-currency cost, different account resolution, and no actor record.
- `depreciation_start_date` was ignored by both engines: assets not in service
  still depreciated, and every open month was treated as a full month.
- Acquisition posting ran from the browser; a failed capitalisation entry was
  logged to the console only, so an asset could exist with no journal entry.

Journal *writing* was already correct — everything went through
`post_journal_entry_atomic`. The defect was the **amount**, not the posting engine.

Root cause: there was no server seam for depreciation, so the browser became the
accounting authority by default.

## 2. Remediation

Three database routines, one shared calculation:

| Routine | Role |
| --- | --- |
| internal calculation | single source of the period amount |
| `fa_depreciation_plan(business, period, branch)` | read-only preview; writes nothing |
| `fa_post_depreciation(business, period, branch)` | recomputes and posts; **takes no amount from the caller** |

`fa_post_depreciation` enforces, in order: `assert_can_manage_assets`, an
authenticated actor, `is_period_locked` (closed fiscal period refused),
`pg_advisory_xact_lock` on business+period, `FOR UPDATE` row locks per asset,
server-side recalculation, posting through `post_journal_entry_atomic` dated at
period end, and a unique-constrained schedule row per asset and period.

Also delivered: `fa_create_asset` posts the capitalisation entry server-side and
refuses on failure; the competing edge function is removed;
`useDepreciationRun` is now a thin caller that sends no amounts.

## 3. Verification (fixtures `ZZTEST-FIXEDASSET`, 9 assets, 4 categories)

No real fixed asset existed in the system; the fixtures were the only asset rows.

| Test | Expected | Actual | Result |
| --- | --- | --- | --- |
| Preview writes nothing | ledger unchanged | counts identical before/after | Pass |
| Straight line | 2,000.00 | 2,000.00 | Pass |
| Reducing balance | 1,562.50 | 1,562.50 | Pass |
| Mid-month in-service start | 1,032.26 | 1,032.26 | Pass |
| Residual-value floor | 100.00 | 100.00 | Pass |
| Not yet in service | refused | `NOT_IN_SERVICE` | Pass |
| Fully depreciated | refused | `FULLY_DEPRECIATED` | Pass |
| Missing useful life | refused | `INVALID_USEFUL_LIFE` | Pass |
| Missing GL mapping | refused, nothing posted | `MISSING_GL_MAPPING` | Pass |
| Posting | balanced entries at month end, right accounts/branch, actor recorded | 5 entries JE-00019…JE-00023 | Pass |
| Re-run same period | nothing posted | 0 posted, all `ALREADY_POSTED` | Pass |
| Branch scoping | other branch untouched | untouched | Pass |
| Permission | refused by the database | refused without `finance.manage_assets` | Pass |
| **Manipulated input** | ledger receives the authoritative amount | the routine accepts no amount parameter at all | Pass |
| Closed fiscal period | refused | `FA_PERIOD_CLOSED: … 2026-09-30 is closed` (test rolled back) | Pass |
| Duplicate schedule row | refused | unique violation on `depreciation_schedules_asset_id_period_start_key` | Pass |

Concurrency: a genuine two-session race could not be executed — this project is
an external Supabase instance with no mintable authenticated session, and the
SQL tooling gives one connection. The protection is nonetheless structural and
partly proven: an advisory transaction lock keyed on business+period serialises
runs, each asset row is locked `FOR UPDATE`, and the unique index is the final
backstop — demonstrated above by rejecting a duplicate row directly. A live
two-session test should be added to the e2e harness when a test session exists.

Operational finding: the ledger refused a current-month posting because the
month-end branch business day is not open yet and a day cannot be opened for a
future date. **Depreciation for the current month can only be posted on or after
month end.**

## 4. Lifecycle review (read-only, nothing rebuilt)

| Area | State |
| --- | --- |
| Depreciation | Fixed — server-authoritative |
| Acquisition | Fixed — server-authoritative, fails loudly |
| Edit | Partly functional — cost/life locked once depreciation exists (database-enforced) |
| **Disposal** | **Same defect class as the old depreciation code**: `useFixedAssets.disposeAsset` flips the asset to `disposed` first, then the browser computes proceeds, book value and gain/loss and posts the entry; on GL failure it only toasts, leaving a disposed asset with no disposal entry, and missing mappings skip posting silently. Needs an `fa_dispose_asset` routine on the same pattern. |
| Retirement | Not implemented as a distinct path (only a disposal "method") |
| Transfer (branch/department) | Not implemented |
| Depreciation reversal | Not implemented — no unpost/reversal path for a depreciation run |
| `deleteAsset` | Hard-deletes the asset row from the browser with no guard against posted depreciation |

## 5. Cleanup and integrity

- The five test journal entries were reversed through
  `void_journal_entry_atomic` — the system's own mechanism — never deleted.
  Both sides remain as an audit pair; net movement on the two affected accounts
  is exactly 0.00 across all ten entries.
- Fixture rows removed: 9 assets, 4 categories, all their depreciation
  schedules and entries. `fixed_assets`, `asset_categories`,
  `depreciation_schedules` and `depreciation_entries` are back to 0 rows.
- Unchanged: 2 branches, 1 business, no ZZTEST accounts were ever created, no
  fiscal period left closed (0 closed periods), and no non-fixture record was
  touched.

## 6. Remaining gaps

1. Disposal authority (highest priority — same class of defect that was just fixed).
2. Live concurrent-run test in the e2e harness.
3. Depreciation reversal / unpost path.
4. Asset transfer and a real retirement path.
5. Guard or soft-delete on `deleteAsset`.

## 7. Follow-up wave — disposal authority and delete guard (same day)

Gap 1 and gap 5 from section 6 are now closed.

**Disposal** — new `fa_dispose_asset(business, asset, date, proceeds, reason,
payment_method)`, built on the same pattern as `fa_post_depreciation`:

- `assert_can_manage_assets` + authenticated actor,
- `pg_advisory_xact_lock` on the asset and `SELECT … FOR UPDATE`,
- asset must belong to the caller's company; disposal date cannot precede
  purchase; `is_period_locked` refuses a closed period,
- refuses a second disposal (`FA_ALREADY_DISPOSED`) when the asset is already
  disposed or a non-voided `asset_disposal` entry exists for it,
- required GL mappings resolved server-side (category first, then default
  account settings); missing mapping raises `FA_MISSING_GL_MAPPING` **before**
  anything is posted,
- **cost, accumulated depreciation, book value and gain/loss are computed by
  the routine**; the caller supplies only the disposal date, the actual
  proceeds and the reason — no accounting amount,
- posts through `post_journal_entry_atomic` (Dr settlement, Dr accumulated
  depreciation, Cr asset at cost, Dr/Cr gain or loss), branch-stamped from the
  asset, and raises if the ledger refuses — the asset can no longer end up
  disposed without its entry.

`useFixedAssets.disposeAsset` is now a thin caller of that routine; the
browser-side entry construction, the `postToGL` call, the swallowed GL error
and the silent "missing mappings" skip are removed.

**Delete guard** — `BEFORE DELETE` trigger `fa_guard_asset_delete` on
`fixed_assets` refuses deletion when the asset has accumulated depreciation,
any depreciation schedule/entry, or a non-voided acquisition, depreciation or
disposal journal entry (`FA_ASSET_HAS_ACCOUNTING`). Assets with history must be
disposed, not deleted.

Remaining gaps after this wave: live concurrent-run test in the e2e harness,
depreciation reversal/unpost path, asset transfer and a distinct retirement
path.
