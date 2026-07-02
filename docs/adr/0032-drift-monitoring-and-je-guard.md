# ADR 0032: Drift Monitoring & Manual Journal AR/AP Guard

## Status
Accepted — 2026-06-02

## Context
ADR-0029…0031 made the customer/vendor ledgers a strict projection of the
General Ledger and added database triggers that reject AR/AP control-account
lines without a `contact_id`. Two gaps remained:

1. **UX gap.** The triggers reject bad journals only at save time. A finance
   user could compose a 30-line manual journal and only learn about the
   missing customer/vendor on submit.
2. **Observability gap.** Although the new architecture makes drift
   impossible by construction today, finance had no audit trail proving the
   system stayed reconciled day-over-day, and no early warning if a future
   bug or manual SQL fix broke the invariant.

## Decision

### 1. Client-side AR/AP integrity guard
`src/pages/JournalEntries.tsx` (the manual journal editor) now:
- Reads `accounts.system_role` (added to the `Account` interface) to detect
  AR/AP control accounts per line.
- Renders a required `ContactCombobox` on those lines (customer for AR,
  vendor for AP — `src/components/finance/ContactCombobox.tsx`).
- Disables the Save button and surfaces an inline error listing the offending
  line numbers until every control-account line has a contact selected.

The DB trigger remains the source of truth; the client guard is a UX
shortcut that mirrors it.

### 2. Drift audit trail (`control_account_drift_log`)
New append-only table capturing per-org, per-account drift snapshots:
`gl_balance`, `subledger_balance`, `drift`, `snapshot_at`.

- RLS: organization members can SELECT their own org's rows
  (via `user_belongs_to_org`); only the service role can INSERT.
- Indexed on `(organization_id, snapshot_at DESC)` for cheap recent-history
  queries.

### 3. Scheduled snapshot
`public.snapshot_control_account_drift()` inserts only rows where
`abs(drift) > 0.005`. Scheduled via `pg_cron` job
`snapshot_control_account_drift_daily` at `0 2 * * *` UTC.

Healthy days produce **zero** rows, so any new row IS the alert — downstream
notification can simply tail `WHERE snapshot_at > now() - interval '1 day'`.

## Consequences
- Manual journals can no longer be saved with a control-account line missing
  a customer/vendor — both on the client (immediate feedback) and on the
  server (defense in depth).
- Drift, if it ever re-emerges, leaves a permanent timestamped trail tied to
  the offending account and organization, making root-cause analysis a SQL
  query instead of a forensic exercise.
- The cron job is idempotent (`unschedule` guarded by a NULL exception
  handler) and safe to re-run on every migration.

## Closure
This concludes the AR/AP single-engine programme started in ADR-0029. The
customer ledger, vendor ledger, partner ledger report, and GL trial balance
now agree by construction, are protected from regression by database
triggers, are guarded at the UI for the primary write path, and are audited
nightly. Big-system parity (subledger ⇄ GL ⇄ partner reports, with
detectable drift) is in place.
