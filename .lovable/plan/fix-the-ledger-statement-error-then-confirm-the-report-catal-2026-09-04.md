# Fix the ledger/statement error, then confirm the report catalogue is microfinance-only

## 1. The error — root cause confirmed

Checked directly against the live database:

- `journal_entries.status` is the enum type `journal_status`.
- `public.ledger_visible_journal_statuses()` returns **`text[]`** (`ARRAY['posted','reversed']::text[]`).
- Six functions filter with `je.status = ANY (public.ledger_visible_journal_statuses())`, comparing an enum to text with no cast. Postgres has no such operator, so every call fails with exactly the message on screen: `operator does not exist: journal_status = text`.

Affected functions (all of them power the screens that break):

```text
get_account_movements(_org_id,_date_from,_date_to,_business_id,_branch_id)
get_ledger_opening_balances
get_equity_result
get_journal_report
get_budget_variance_report
check_budget_variance
```

That explains why Financial Statements, Trial Balance, General Ledger and the Journal Report all show the same error — they share these functions.

### The fix

One migration: redefine `ledger_visible_journal_statuses()` to return `journal_status[]` (`ARRAY['posted','reversed']::journal_status[]`), which makes the existing `= ANY (...)` comparisons type-correct and index-friendly. Return type changes require drop-and-recreate; the six callers store their bodies as text, so they are unaffected, but each will be re-created unchanged in the same migration so the whole set is proven to compile against the new signature. Execute permissions re-granted to `authenticated`, `anon` revoked, exactly as today.

Verification after the migration: call each of the six functions directly and confirm rows return instead of an error, then load Financial Statements, Trial Balance, General Ledger and the Journal Report in the app.

## 2. The journal download error

The error text for the download attempt did not come through in the message — it ends at `throws this error -->`. Most likely it is the same enum mismatch surfacing through the server-side PDF path (`reportDataEngine` calls the same functions), in which case step 1 fixes it too. After the migration I will trigger a journal download and, if it still fails, capture the real error and fix that separately rather than guessing now.

## 3. Report catalogue — verified already clean

I checked the catalogue before proposing work here, and the orphaned ERP report families are already gone:

- `ReportRegistry` categories are `statutory`, `lending`, `cash_bank`, `fixed_assets`, `audit`, `management` — no FX, tax, inventory, sales, payroll or partner-ledger categories remain.
- `reportsNav` families are `lending`, `statements`, `ledgers`, `cash`, `planning`, `integrity`, `analytics` — no currency/FX family.
- `src/pages/reports/` contains only the eleven retained pages; no FX Exposure, FX Revaluation, Stock, Stock Adjustment or Stock Transfer report pages exist, and no routes reference them.

So no removal work is proposed here. If you are still seeing an FX or other ERP report link in the running app, tell me where you clicked it and I will trace that specific entry point — it would be a stale link outside the registry, not a catalogue entry.

## Scope

This wave is the ledger fix only. No changes to the posting engine, report layouts, navigation or the microfinance domain work.
