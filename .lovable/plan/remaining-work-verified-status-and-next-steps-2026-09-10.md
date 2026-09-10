# Remaining Work — verified status and next steps

## Verification verdict (checked against the live database and the code, not the notes)

Branch Operational Day is **built and in place**. Confirmed present:

- `branch_operational_days` (branch/business/organization scope, status, opening/expected/counted cash, variance, variance reason, variance journal entry, reopened count, opened/closed by and at).
- `branch_day_events` append-only log with its protective trigger.
- `open_branch_day`, `close_branch_day`, `reopen_branch_day`, `branch_day_cash_report` — all present and privileged (SECURITY DEFINER).
- Day locks on the ledger (`journal_entries`) and on collection rounds (`mf_repayment_batches`).
- Per-branch switch-on date and cash variance tolerance on `branches`.
- Fiscal period close now writes both closed markers, and the open check reads both — the defect found during planning is fixed.
- Screens: branch day page, day-bounded date field used by repayments, group sheet, fee collection, disbursement and banking dialogs, daily branch cash report.
- Structural invariants test file in place.

Nothing from the previous run needs redoing. What follows is only what is still open.

## 1. Owner walkthrough of the day lifecycle (blocked on you)

The only way to finish this is a signed-in pass in the preview, on your own Supabase login. Steps to walk: open today at a branch, record one payment, try a payment dated a closed day, close the day with a counted cash figure, reopen it with a reason, then open the next day. I cannot sign in on your behalf.

## 2. Legacy ERP data removal

- **Drop the old `payments` and `payment_allocations` tables.** They belong to the inherited ERP, not to this institution. Repoint or remove the handful of places that still read them (audit log formatting, a governance option list, a payment-clearing hook, a report contract test, the transactional-data reset card), then drop the tables.
- **Drop the old `contacts` table.** Journal counterparties move to `mf_clients`. Contact helpers, the customer command-palette provider and the journal entry snapshot need repointing first.

Each removal ships as its own small migration, after the code no longer reads the table.

## 3. Housekeeping

- **Orphan function purge** — remove database functions left behind by the removed ERP domains.
- **Linter posture** — clear the inherited warnings on the schema we keep (tables without row-level security, definer views).
- **Resource Center** — remove the inert demo-video section; the data source behind it is already gone.

## 4. Microfinance gaps

- **Report gaps** — finish the report catalogue for lending (the day cash report is done; the rest of the gap list still stands).
- **Document gaps** — remaining printable documents for the lending flow.

## Suggested order

1. Owner walkthrough (you) — can run in parallel with everything else.
2. Payments / payment allocations removal.
3. Contacts removal.
4. Orphan functions, then linter posture.
5. Resource Center cleanup.
6. Report gaps, then document gaps.

## Non-goals

No redesign of the day engine, lending, meetings, fiscal periods or bank reconciliation. No new permission system — the day engine keeps using the existing capability framework. No back-filling of historical days.

## Open point

The report and document gap lists (items 4) were scoped by the earlier run but not itemised here. Before starting them I will list exactly which reports and documents are missing, so we agree on the scope rather than discovering it mid-build.
