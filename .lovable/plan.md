# Remaining Work — verified status after the interrupted run

## What I verified is genuinely done (not just claimed)

Checked directly against the live database and the code, not against the old notes:

- **Branch Operational Day engine exists and is live.** Both tables (`branch_operational_days`, `branch_day_events`) are present, all four routines (`open_branch_day`, `close_branch_day`, `reopen_branch_day`, `enforce_branch_day_lock`) exist, and three day-lock triggers are installed. No day rows yet, which is correct — day control is inert until a branch is activated.
- **The day surface is built**: branch day screen, day-bounded date fields on payment, group sheet, disbursement, fee collection and bank batch dialogs, the stale-open-day alert, and the daily branch cash report.
- **Fiscal period close/reopen divergence** was fixed.
- **Old ERP payment records are gone**: `payments` and `payment_allocations` no longer exist; the demo-video table is also dropped.

So the operational-day remediation itself is complete. What was left unfinished is the surrounding clean-up plus the owner walkthrough.

## What remains

### 1. Owner walkthrough of the day lifecycle (blocked)
Open a day, record money against it, close it, try a closed-day entry, reopen it — all signed in as a real user. This needs a preview sign-in on your own Supabase project; I cannot mint a session for it. **Blocked on you signing in once in the preview.**

### 2. Retire the old contacts table (M5b)
The old customer table is empty but still wired into around a dozen places: the journal entry counterparty picker, entity resolution, contact hierarchy and addresses, document snapshots, the command-palette customer search, and field-settings pickers. Work: point the counterparty picker and search at the client list, remove the dead contact helpers and their test, then drop the table together with its links on the other tables.

### 3. Remove the inert Resource Center video section
`useDemoVideos` is now a stub returning nothing and its table is dropped, but the launcher still renders the section. Remove the section, the hook and the dead types.

### 4. Purge orphan database routines (M7)
Routines left behind by the removed ERP modules. Enumerate what no longer has any caller in code or in another routine, then drop in one reviewed batch — nothing dropped without first proving it has no caller.

### 5. Database security posture review (M8)
Run the linter over the retained schema and clear the inherited warnings, or record each one with the reason it is acceptable.

### 6. Microfinance report gaps (M9) and document gaps (M10)
Fill the remaining report catalogue entries and document templates that the microfinance domain still lacks.

## Order I intend to work in

1. Resource Center section removal (small, self-contained).
2. Contacts retirement — code retarget first, table drop last.
3. Orphan routine purge.
4. Linter posture.
5. Report gaps, then document gaps.
6. Owner walkthrough whenever you can sign in.

## Rules carried forward

- Authorization stays on the existing permission framework — day capabilities are permissions assigned to configurable roles, never hard-coded job titles.
- No second accounting engine, no second reconciliation engine, no duplicated totals.
- Every drop is preceded by proof that nothing calls it.
