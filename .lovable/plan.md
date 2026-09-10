# Branch Operational Day — Production-Safe Behavioural Test Wave

## Objective

Prove two things at once:

1. The branch operational day (open / date control / close / reopen) is enforced at the
   database boundary, not just in the screens.
2. Every existing production record — clients, groups, meetings, applications,
   application-fee transactions, journal entries and their lines, balances, branch
   assignments — is byte-identical before and after the test, and nothing test-created
   survives.

## What already exists (verified)

- `supabase/tests/branch_operational_day_invariants_test.sql` asserts *structure only*
  (unique indexes, grants, RLS, append-only history, guard triggers on `journal_entries`
  and the collection-round table, RPC privileges). It writes no rows.
- Behavioural routines to exercise: `open_branch_day`, `close_branch_day`,
  `reopen_branch_day`, `branch_day_expected_cash`, plus the `enforce_branch_day_lock`
  trigger at the ledger choke point (`post_journal_entry_atomic` is the single GL writer).
- Authority comes from the existing permission framework (`mf_can_scoped`), so the test
  must impersonate roles/claims rather than invent a new permission path.

The behavioural half has never been run. That is this wave.

## Safety mechanism

No production row is read-modified-written at any point. Test fixtures are created fresh
and the whole run is aborted so the database returns to its exact prior state.

- Everything runs inside **one transaction that is deliberately aborted at the end**.
  The final statement raises a sentinel exception carrying the assertion results, so all
  fixtures, day rows, events and journal entries created during the run disappear.
  Nothing is deleted afterwards — nothing was ever committed.
- Fixtures live under **two temporary branches inside the existing single business**
  (no second business, no tenant). Names are prefixed `ZZTEST-DAY-` and IDs are captured
  into a registry table variable so every assertion can name what it created.
- Test clients / groups / a test loan and its payments are created new. No production
  client, group, meeting, application or fee transaction is referenced, re-dated,
  reversed or reassigned.
- Roles/claims are simulated with `set_local` on the JWT claim settings and
  `SET LOCAL ROLE` — transaction-scoped, so authorisation is exercised as real users
  experience it without touching account data.

### Before/after integrity proof (value-level, not counts)

Inside the same transaction, before creating any fixture, compute a per-table digest over
the protected production rows — `md5(string_agg(row_to_json(t)::text, '|' ORDER BY id))` —
for: `journal_entries`, `journal_entry_lines`, `accounts`, `mf_clients`, `mf_groups`,
`mf_group_meetings`, `mf_loan_applications`, `mf_client_charge_payments`,
`mf_fee_collections`, `mf_repayments`, `mf_repayment_batches`, `mf_collection_bankings`,
`branches`, `branch_operational_days`, `branch_day_events`. Recompute the same digests
after the assertions, excluding rows whose id is in the test registry. Any digest drift
fails the run and is reported by table name.

## Assertions

**Opening** — day opens on temp Branch A with correct business/branch scope; a second open
day on the same branch is refused; future date refused; a date earlier than the last closed
day refused; a caller lacking the open capability refused; Branch B's state unchanged.

**Dating** — a posting dated inside the open day succeeds; a posting dated a closed day is
refused; once control is active, a posting dated a never-opened day is refused; a Branch A
posting cannot land in Branch B's day; the guard cannot be bypassed by calling the lower-level
ledger writer directly.

**Closing** — close succeeds when conditions are met; status and close event recorded;
expected cash matches the ledger-derived figure; variance = counted − expected; a variance
without the required reason/authority is refused; Branch B's day is untouched.

**After closing** — postings and reversals against the closed day are refused at the ledger
boundary, by every path; production journal entries still digest-identical.

**Reopening** — refused without the capability; allowed with it; reason mandatory; event
auditable; workflow usable again after reopen; Branch B unaffected.

**Zero-activity day** — a temp branch with no clients, loans, repayments or collections
opens and closes cleanly. This is asserted before any financial fixture is created, so the
day engine is proven not to depend on lending activity.

**Branch isolation** — closing A does not block B opening or posting; neither branch can post
into the other's day; a user scoped to one branch cannot cross; all rows stay in the one business.

## Stop conditions

If temporary branches cannot be created without side effects, or if the day guard cannot be
exercised without touching a production record, the run stops and reports: which assertion
could not be made safely, which isolation capability is missing, which records would have
been at risk, and what isolated environment would be needed. No improvisation, no borrowing
of a real client or entry.

## Technical notes

- The sandbox has no direct `psql` credentials, so the harness is executed through the
  migration channel as a single self-aborting transaction; it therefore leaves no migration
  effect and no committed rows. The same file is also saved as
  `supabase/tests/branch_operational_day_behaviour_test.sql` so it can be re-run against a
  local `supabase db reset` stack.
- No application code, RPC or trigger is changed in this wave. If an assertion fails, the
  defect is reported with the exact refusal or missing refusal; remediation is a separate,
  approved step.

## Deliverable

A report listing: digests before/after per protected table, every test-created identifier,
each assertion with pass/fail and the exact database refusal observed, the zero-activity
result, the isolation result, and confirmation that nothing test-created persists.



==================PROGRESS STATUS====================
I stopped before running the test. Here's where things stand.

Done: I wrote the production-safe behavioural test at supabase/tests/branch_operational_day_behaviour_test.sql. It runs as one transaction that deliberately aborts at the end, so nothing it creates is ever saved. It builds three temporary branches of its own (named ZZTEST-DAY-A/B/C), never touching a single real client, group, meeting, application or accounting entry, and it fingerprints every protected table before and after so any change to real records would be caught by value, not by counts.

It checks: opening a day (and refusing a second open, a future date, a date before control starts, and a user without permission), money dated into the open day being accepted while a never-opened day and another branch's day are refused at the ledger itself, closing with the correct expected cash and a mandatory reason for any difference, refusal after closing, reopening only with authority and a reason, work resuming after reopen, branch-to-branch isolation, and a branch with no lending activity at all opening and closing cleanly.

Two things I found while preparing it, worth your attention:

Day control is currently switched off at both real branches (no start date set), so no live branch is enforcing the day yet.

The "cash over/short" accounting mapping is not configured, so closing a day with a cash difference would currently fail at the accounting step. The test will confirm this.

Remaining: run the test and report the results, then record the outcome in the project status file.