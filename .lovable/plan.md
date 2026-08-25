# Projects Domain — Wave 4 closure (4.4, 4.6), then Wave 5

## Verification of the previous session's claims (done this pass)

Checked directly against the live database and the current checkout:

| Claim | Verdict |
|---|---|
| Mirrored `project_members.role` dropped, `project_role` remains | Confirmed — `role` column absent, `project_role` present |
| `project_add_member` rebuilt as the 6-argument version writing `project_role` only | Confirmed — single signature `(uuid,uuid,text,numeric,boolean,boolean)`, no reference to the old column |
| Workload view derives capacity from HR work schedules | Confirmed — the view definition reads `work_schedules` |
| 4.4 (one canonical timesheet writer) still pending | Confirmed — no `src/lib/timesheets/` module exists; four separate places still write time rows |
| 4.6 (guard test for a single time writer) still pending | Confirmed — the guard test has three suites, none covering timesheet writes |

So Wave 4.5 genuinely landed. Resume exactly at 4.4.

## Additional defects found while verifying (folded into 4.4)

Two of the project time-logging screens write timesheet rows directly and:

- omit `business_id`, so rows are created without the business that owns them — a real
  isolation and reporting gap, not a cosmetic one;
- hardcode the entry as non-billable regardless of whether the project is billable, so
  billable work silently loses revenue;
- duplicate the "find my employee record" lookup twice, in slightly different ways.

These are fixed as part of consolidating onto one writer, not as separate patches.

## Work to do

### 4.4 — One canonical timesheet writer
- Add `src/lib/timesheets/timesheetWriter.ts` as the only module allowed to insert,
  update, or delete `timesheets` rows. It always sends `organization_id` and
  `business_id` from the active workspace, always leaves billing rate and amount to
  the server trigger, and exposes a shared "resolve my employee record" helper.
- Point the existing writers at it: the timesheets hook (create, update, delete, copy
  previous week), the project timesheets panel, and the task detail time logger.
- Billability comes from the project's configuration through the server, never from a
  hardcoded client value.

### 4.6 — Guard test
- Extend the projects architecture guard test with a "single canonical timesheet
  writer" suite that fails the build if any file outside the writer module performs an
  insert, update, or delete against `timesheets`.
- Re-run the existing Projects suites and the type check, and re-run the SQL scenario
  test `supabase/tests/projects_wave4_timesheet_authority_test.sql` to prove no
  regression on the database side.

### Then Wave 5 — Commercial & financial integration
Budget semantics, project cost and revenue writers, analytic-account linkage
end-to-end, invoicing from billable time, profitability from canonical data only —
scoped in a follow-up once Wave 4 is closed and verified.

## Status file
On completion, update
`.lovable/plan/projects-domain-reconstruction-authoritative-status-2026-08-25.md`:
4.4 and 4.6 done with evidence, Wave 4 closed, Wave 5 next.
