# Finance Reports — Four Failing Reports: Root Causes and Fix Plan

All four causes below were confirmed directly against the live database and the code, not inferred.

## A. Journal Report — "structure of query does not match function result type"

Confirmed root cause: the database function `get_journal_report` declares `entry_status text`, but its final SELECT returns `p.status`, which is the enum type `journal_status`. Postgres cannot coerce an enum to the declared text column, so every call fails. Every other returned column is genuinely `text`, so this single column is the whole defect.

Fix: one migration recreating `get_journal_report` with `p.status::text` (all other logic, filters, authorisation checks, ordering and pagination unchanged). No frontend change — the page contract is already correct.

Also affected by the same function: the server-side PDF/CSV path (`reportDataEngine`) uses the same function, so it is fixed by the same change.

## B. Audit Trail — `public.v_unified_audit` not found

Confirmed: the view is defined in migration `20260525094000`, but it does not exist in this database. Its definition unions eight audit tables, and three of them — `timesheet_audit_log`, `signature_audit_log`, `pack_audit_log` — do not exist here, which is why the original migration could not be applied to this project. The other five sources do exist and hold real audit history (`audit_logs` currently has records).

Fix: a migration recreating `v_unified_audit` with the same row contract (source table, id, organization, business, actor, action, entity type, entity id, summary, payload, occurred at) built only from the audit tables that exist in this database: `audit_logs`, `account_change_audit_log`, `settings_audit_log`, `commercial_audit_logs`, `default_account_mapping_audit`, plus `admin_audit_log` and `identity_change_audit_log` where their columns map cleanly. Security-invoker is set so each underlying table's own access rules still apply; no audit record is created, altered or deleted.

## C. Report Run History — `public.report_run_log` not found

Confirmed: no migration anywhere in the repository ever created this table, yet six code paths write to it (the PDF renderer and the shared screen/CSV/XLSX logger) and one page reads it. So every report run has been silently failing to record itself, and the reader page errors.

Fix: a migration creating `report_run_log` exactly to the contract the existing writers already use (organization, business, user, report type, parameters, run hash, byte count, status, created at), with row-level security limiting reads to members of the same organisation, the grants the platform requires, and indexes on organisation + time. No writer or reader code changes; they were already correct against this contract. After the table exists, running a report will create a history row, and failures will be recorded with error status rather than as successes.

## D. Control Account Reconciliation — never finishes loading

Confirmed root cause, two parts:

1. The function `get_control_account_reconciliation` reads `invoices` and `bills` to compute the sub-ledger side. Neither table exists in this database — this deployment is microfinance-only and those sales/purchase ledgers were removed. The call therefore throws every time.
2. The screen never shows that failure: the hook exposes an error but the page passes only the loading flag to the report layout, so the failure is swallowed and the page sits on a spinner.

Fix, in this order:

- Surface the failure: pass the query error through to the report layout so a broken report says so instead of hanging. This is error handling, not a workaround for the cause.
- Make the report truthful for this deployment. The authoritative sub-ledger here is the microfinance ledger (`mf_loans` principal outstanding, `mf_client_charges` less `mf_client_charge_payments`), not invoices and bills. The function will be recreated so the receivable side reconciles the configured receivable control account against those authoritative microfinance balances, using the same organisation/business/branch scoping and the same migration-opening-balance handling it uses today. The payable side has no sub-ledger in this deployment, so instead of inventing one the report will state plainly that no payable sub-ledger is configured rather than reporting a false zero or a false drift.

If you would rather retire this report entirely for a microfinance-only install than retarget it, say so and I will remove it and its navigation entry instead.

## Scope, safety and verification

- All four fixes are database migrations plus one small error-surfacing change on the reconciliation page. No accounting calculation moves into the frontend.
- Existing authorisation is reused unchanged: the journal and reconciliation functions keep their organisation/business/branch authorisation gates, and the two new/restored objects rely on row-level security over their underlying tables.
- Read-only verification against existing real data: the journal report loaded with date, branch, business and source filters plus an empty range; the audit trail loaded and filtered against the existing audit records; the reconciliation completes and its figures are checked against the ledger.
- One controlled write test only: running a report to confirm a run-history row appears, kept as legitimate history rather than deleted.
- Regression check limited to the direct dependents of the changed functions — the server-side journal PDF/CSV path, and the receivable/payable cards that share the reconciliation function.
- Result of every check goes into a test table in the final report, together with anything still outstanding.

=============IMPLEMENTATION PROGRESS AND WHERE THINGS STAND================


Here's where things stand on the four failing Finance reports.

Fixed and applied to the database

Journal Report — the report function was returning the entry status in the wrong format; corrected. The original error should be gone.

Audit Trail — the combined audit view never existed because it referenced three tables that aren't in this database. Rebuilt it from the audit records that do exist; it now returns 91 records (general activity 42, identity changes 24, account changes 24, settings 1).

Report Run History — the missing history table now exists, with access limited to members of the same organisation, so the page can load and future report runs get recorded.

Control Account Reconciliation — the receivables figure now comes from your real lending data (outstanding loan principal and unpaid client fees) instead of sales invoices, which don't exist here. Payables now report honestly that there's no payable sub-ledger rather than showing a made-up balance.

Not finished

I couldn't run the two report functions directly as a verification step (the query tool isn't permitted to call them, and no direct database shell is available here), so the journal and reconciliation fixes are verified by definition but not yet by a live run in the app.

The reconciliation page still doesn't display an error if the data call fails — it just keeps spinning. That small screen change, the removal of the now-meaningless Payables tab, and the regression test run are still outstanding.

Credits ran out mid-way, so continuing this needs available credits. The database repairs above are already live; only the on-screen error handling and final verification remain.