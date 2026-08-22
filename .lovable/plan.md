# Budgets domain — authoritative status

Last updated: 2026-08-22

## Verdict

The budget engine is correct and isolated at the database layer, and the UI no
longer misreports variance. One acceptance step remains and it cannot be
automated on this project.

## Phase status

| Phase | Work | Status |
|---|---|---|
| A | Revoke `anon` / `PUBLIC` execute on the budget RPCs; grant `authenticated` + `service_role` only | Done — migration applied, verified in `pg_proc.proacl` |
| B | Stop netting revenue and cost in the budget analysis chart | Done — four series (revenue plan/actual, cost plan/actual); pinned by an architecture test |
| C | Browser acceptance: seed → activate → revise → read report through the UI | **Blocked** — `LOVABLE_BROWSER_AUTH_STATUS` is `external_unmanaged`, so no preview session can be minted. Needs a signed-in human pass. |
| D | SQL two-tenant isolation fixture | Done — `supabase/tests/budgets_isolation_test.sql`, executed against the live database, passed, rolled back |
| E | ADR | Done — `docs/adr/0150-a-budget-figure-is-a-server-answer-scoped-to-one-company.md` |
| F | Closing sweep | Done — architecture suite green (21 tests) |

## What Phase D proves

Run in one transaction that aborts at the end, as the `authenticated` role so
RLS is live:

- organization B reads **zero** rows of organization A's `budgets`,
  `budget_items` and `budget_revisions`;
- `get_budget_variance_report`, `get_period_budget_variance` and
  `check_budget_variance` answer a foreign caller with `42501`, not an empty
  set — an empty set is indistinguishable from "no data" and would hide a
  scoping bug;
- the owning user still reads their own budget and still gets variance rows,
  so the gate discriminates by membership rather than by refusing everyone;
- every budget function is executable by `authenticated` and not by `anon`;
- all four budget tables have RLS enabled with at least one policy.

## Remaining work (Phase C, human)

Against the preview, signed in:

1. Create a budget for the current fiscal year with at least one income and
   one expense line.
2. Activate it; confirm the status transition is refused for a closed period.
3. Post a journal entry against a budgeted account; confirm the actual moves
   only after posting, and by the posted amount.
4. Raise a revision; confirm the plan changes and the revision is recorded.
5. Open the analysis chart; confirm revenue and cost are separate bars and
   neither is the sum of the other.

Until step 5 is confirmed by eye, treat the domain as verified-by-database and
unverified-by-UI.
