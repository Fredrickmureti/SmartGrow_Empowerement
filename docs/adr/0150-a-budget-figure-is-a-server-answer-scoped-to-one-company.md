# ADR 0150 — A budget figure is a server answer, scoped to one company

Status: Accepted — 2026-08-22
Supersedes: nothing. Extends ADR 0101 (single governance engine).

## Context

The budget domain reached this wave with three claims made by the previous
engineering pass: that variance is computed in exactly one place, that budget
reads are gated, and that the UI is a pure projection of the engine. Two of
those claims did not survive verification.

1. `get_budget_variance_report`, `get_period_budget_variance` and
   `budget_fiscal_months` carried `EXECUTE` for `anon` and `PUBLIC` in
   `pg_proc.proacl`. Their internal `_budget_assert_read` gate meant no row
   actually leaked, but the surface was reachable by an unauthenticated
   caller. Defence in depth is not "one gate we happen to trust".
2. The budget analysis chart summed income actuals and expense actuals into a
   single bar. Revenue is credit-normal and cost is debit-normal; adding them
   produces a number that is neither, and a plan-vs-actual reading of it is
   meaningless.

## Decision

**1. The budget surface is authenticated-only, at the grant level.**
Every budget function is granted to `authenticated` and `service_role` only.
`anon` and `PUBLIC` are revoked. The in-function `_budget_assert_read`
membership check stays — the grant is the outer wall, the assert is the inner
one, and neither is allowed to be the only one.

**2. Isolation is proven by the database, not by the client.**
`supabase/tests/budgets_isolation_test.sql` boots two organizations in one
transaction, and asserts, as the `authenticated` role so that RLS actually
applies, that organization B reads zero of organization A's budgets, budget
lines and revisions, and that all three read RPCs answer a foreign caller with
`42501` rather than an empty set. The same fixture asserts the owner is *not*
blocked, so the gate cannot be satisfied by being uniformly restrictive.

**3. Revenue and cost are never netted.**
The analysis chart plots four series — revenue plan, revenue actual, cost plan,
cost actual. No view may add an income figure to an expense figure. This is
pinned by an architecture test
(`src/test/architecture/budgets-single-source-of-truth.test.ts`) so the netting
cannot come back as a "simplification".

## Consequences

- Any new budget RPC must ship with its grants written explicitly; a default
  grant is a review failure.
- A budget widget that wants a single "net" bar must first define, in writing,
  which normal balance it is expressing. In practice this means it plots two
  series instead.
- The isolation fixture is the acceptance gate for the domain. It rolls back,
  so it can be run against any environment, including production.

## Open

Browser-level acceptance (seed a budget through the UI, activate, revise, read
the report) is still outstanding: this project is on an external, unmanaged
Supabase, so no preview session can be minted for an automated pass. It must be
performed by a signed-in human against the preview before the domain is called
closed.
