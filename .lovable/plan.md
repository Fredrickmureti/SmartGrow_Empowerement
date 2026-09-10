# Fixed Assets — depreciation authority audit, remediation and full verification

## What the audit already established (verified now, read-only)

Live database:

- `fixed_assets` 0 rows, `asset_categories` 0 rows, `depreciation_schedules` 0 rows, `depreciation_entries` 0 rows, journal entries with source "depreciation" 0. **The module has never been used in production**, so no real asset or depreciation record is at risk. 1 business, 2 branches exist.
- No depreciation routine exists in the database. The only asset-related routines are `assert_can_manage_assets`, `get_next_asset_number`, two business-match guard triggers and a currency stamp trigger.
- `depreciation_schedules` has `UNIQUE (asset_id, period_start)` — a real duplicate guard, but it is not what the code relies on.
- `fixed_assets` has `depreciation_start_date`.

Code:

- `src/hooks/useDepreciationRun.ts` — the browser computes the depreciation amount, then the browser inserts the depreciation record and overwrites `fixed_assets.accumulated_depreciation` and `book_value` directly. The amount handed to the ledger is whatever the browser decided.
- Duplicate protection is a browser-side "check then insert", which two concurrent runs can both pass.
- `supabase/functions/run-depreciation/index.ts` is a **second, divergent** depreciation engine (service-role): it depreciates on transaction-currency cost instead of the base-currency accounting cost, resolves accounts differently, and never records who posted.
- `depreciation_start_date` is ignored by both engines: an asset not yet in service still depreciates, and there is no first-period/partial-period treatment — every open month is a full month.
- Acquisition: `useFixedAssets.ts` posts the acquisition journal from the browser and, when that posting fails, only logs to the console — an asset can be created with no capitalisation entry.
- Journal writing itself is correct: everything goes through `post_journal_entry_atomic` via `useGLPosting`, so the ledger monopoly is intact. The defect is the *amount*, not the posting engine.

Root cause: Fixed Assets was built as a client-side batch job. There is no server seam for depreciation at all, so the browser became the accounting authority by default.

## Remediation

One authoritative database routine, used by both preview and posting. No new journal path — it calls the existing `post_journal_entry_atomic`.

`mf`-style naming aside, the new seam is:

- `fa_depreciation_plan(_business_id, _period_date, _branch_id)` — read-only. Returns per eligible asset: method, base cost, residual, useful life, depreciation start, prior accumulated depreciation, the period amount, remaining depreciable amount, and the resolved expense/accumulated accounts. Writes nothing.
- `fa_post_depreciation(_business_id, _period_date, _branch_id)` — takes **no amount from the caller**. It recomputes from the same internal calculation, refuses on missing account mappings, closed fiscal period, insufficient permission, or an already-posted asset/period, then posts through `post_journal_entry_atomic` and records the depreciation event, the asset's new accumulated depreciation and book value, and who posted.

Both delegate to one internal calculation function so preview and posting can never diverge. Rules it enforces, matching the intent already in the schema and standard ERP treatment: depreciation begins at `depreciation_start_date` (falling back to `purchase_date`), never exceeds cost less residual, stops on a fully depreciated asset, uses the base-currency cost, and is idempotent per asset and period (backed by the existing unique constraint plus row locking, so two concurrent runs cannot both post).

Frontend and cleanup:

- `useDepreciationRun` becomes a thin caller: preview calls the plan routine, posting calls the post routine. Its local formula, its direct writes to `depreciation_schedules` and `fixed_assets`, and its check-then-insert are removed.
- Acquisition posting moves behind the same boundary so an asset cannot be created without its capitalisation entry, and a failure surfaces instead of being swallowed.
- The `run-depreciation` edge function is reduced to a caller of the same routine, so the second engine stops existing.
- Permissions reuse `assert_can_manage_assets` / `finance.manage_assets`. No new roles, no hard-coded role names.

## Verification (isolated fixtures, prefix `ZZTEST-FIXEDASSET`)

Fixtures: a temporary branch, one category per supported depreciation method, and assets covering each boundary. Every created ID recorded.

Matrix run and reported as Test / Expected / Actual / Result / Evidence:

- Category configuration: every field saved, stored in `asset_categories`, and actually consumed by the calculation; required GL mappings enforced; invalid useful life rejected.
- Asset creation through the real screens; which values are inherited vs asset-level; UI value → stored value → engine value.
- Acquisition: journal entry, lines, direction, date, branch, business, asset account.
- Preview: correct assets, period, method, dates, residual, prior depreciation, mappings, rounding — and a before/after digest proving preview writes nothing.
- Independent calculation per method, compared with the authoritative result; any difference explained as convention, rounding or defect, never by adjusting the expectation.
- Posting: one event, balanced journal, correct accounts and direction, branch/business scope, asset reference, audit record, resulting accumulated depreciation and net book value.
- Manipulated-input test: call the posting routine directly with an inflated amount in the payload and prove the ledger still receives the authoritative amount.
- Duplicate and concurrency: second run refused; two simultaneous runs produce exactly one event.
- Controls: closed fiscal period blocked; missing mapping refuses instead of posting an incomplete journal; asset before its depreciation start not depreciated; fully depreciated asset stops; residual floor respected; cross-branch posting refused.
- Permissions: a user without `finance.manage_assets` refused at the backend, not only in the UI.
- Depreciation report / register values reconciled against the underlying records.
- Lifecycle audit: edit, disposal, retirement, transfer, reversal — each classified as functional, partly functional or not implemented. Nothing new built here.

## Cleanup and integrity proof

Digests of `journal_entries`, `journal_entry_lines`, `accounts`, `fixed_assets`, `asset_categories`, `depreciation_schedules`, `depreciation_entries`, `branches`, `businesses` captured before the run and recomputed after cleanup, excluding only the recorded fixture IDs. Test journals are removed through the system's legitimate reversal/void mechanism, never by deleting posted accounting behind the controls. Any drift outside the fixture IDs stops the wave.

## Deliverable

The report you asked for: original architecture, root cause, remediation, proof of the authority boundary via the manipulated-input test, the full test matrix, one complete asset lifecycle with numbers, production-safety statement with exact fixture IDs, and remaining gaps split into fixed / already correct / not implemented / future wave.

=============IMPLEMENTATION PROGRESS AND WHERE THINGS STAND================

Done. Closed-period posting was refused correctly, and the duplicate guard held. A true two-at-once test couldn't be run (this Supabase project won't give me a test sign-in), so I documented the protections that make it safe and flagged it for the automated test suite.

All test data is gone: the five test entries were reversed through the system's own reversal (net effect zero, audit trail intact), and the nine test assets, four categories and their depreciation records are removed. Nothing real was touched.

The report is in docs/finance/fixed-assets-depreciation-authority-report.md. Its main new finding: disposal still has the same flaw depreciation just had — the browser decides the gain/loss, and if the entry fails the asset is still marked disposed. That's the next thing worth fixing.