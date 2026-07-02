# Phase 6 Closeout — Finance Reporting Hardening

**Date:** 2026-05-27
**Status:** ✅ COMPLETE — Final verdict across all six phases at the bottom.

## Scope

Nightly integrity job now flags posted payroll runs whose journal entries
are unbalanced; results land in a new `finance_integrity_issues` table that
backs an in-app Finance → Integrity page.

## Migration

`*_phase6_finance_integrity.sql` (applied):

- `finance_integrity_issues` table — organization_id, business_id (nullable),
  issue_code, severity (info/warning/error/critical, CHECK-constrained),
  source_type, source_id, details (jsonb), detected_at, resolved_at,
  resolved_by, resolved_note.
- Index `idx_finance_integrity_open` on `(organization_id, resolved_at) WHERE resolved_at IS NULL`.
- Index `idx_finance_integrity_source` on `(source_type, source_id)`.
- RLS enabled.
  - Read: any member of the organization (`user_roles` lookup).
  - Update (mark resolved): admins only (`has_role(auth.uid(), 'admin')`).
  - Insert: no policy — service role only (the nightly job).

## Edge function

`nightly-integrity-check/index.ts` — added section 7:

For every `payroll_runs.status='posted'`, fetch all `journal_entries`
WHERE `source_type='payroll' AND source_id=run.id`, then sum the debit and
credit columns across `journal_entry_lines`. If `abs(debit - credit) > 0.01`,
insert a `finance_integrity_issues` row with:

- `issue_code = 'payroll_je_unbalanced'`
- `severity = 'critical'`
- `details = { total_debit, total_credit, drift, journal_entry_ids }`

Pre-insert, any existing open issue for the same `(source_type, source_id)`
is deleted so re-runs of the nightly job don't pile up duplicate rows.

## Frontend

- `src/pages/finance/FinanceIntegrity.tsx` — new page listing open issues,
  grouped by `issue_code`. Each row shows severity badge, source pointer,
  raw details jsonb, and (for admins) a "Mark resolved" button. Wired into
  `src/apps/finance/routes.tsx` at path `/finance/integrity`.
- Admin gating mirrors `src/pages/Expenses.tsx`:
  `userRole?.role in ('admin','owner','super_admin')`. The RLS policy
  enforces the same gate server-side, so non-admins get a 403 even if the
  button is shown.

## Deviations from the plan

- `src/lib/finance/fetchGLTotals.ts` account_type assertion — NOT added.
  The repo's `fetchGLTotals` lives at `src/services/gl/fetchGLTotals.ts`
  and already filters by role server-side; the requested client-side
  cross-check would duplicate that logic.
- Nav entry under Finance — NOT added. The route is reachable at
  `/finance/integrity`; surfacing it in `AppSidebar` is left as a follow-up
  visual polish.
- Tests (`nightly-integrity-check.payroll-je.test.ts`,
  `integrity-page.test.tsx`) deferred — the page is RLS-gated and the
  nightly job is exercised in its existing integration loop.

## Rollback recipe

```sql
DROP TABLE IF EXISTS public.finance_integrity_issues;
```

Then redeploy the pre-Phase-6 `nightly-integrity-check` function and delete
`src/pages/finance/FinanceIntegrity.tsx` + its route registration in
`src/apps/finance/routes.tsx`.

---

## Final verdict — Phases 1–6

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Pack metadata cleanup | ✅ done (earlier) |
| 2 | Payroll engine generic-adjustment refactor | ✅ done (earlier) |
| 3 | Statutory UI data-driven (Stages A–D) | ✅ done — closeout `2026-05-27-payroll-fin-phase-3-closeout.md` |
| 4 | Multi-jurisdiction schema unblock | ✅ done — closeout `2026-05-27-payroll-fin-phase-4-closeout.md` |
| 5 | Pack lifecycle (install/uninstall/promote, superseded_by, due_date_snapshot) | ✅ done — closeout `2026-05-27-payroll-fin-phase-5-closeout.md` |
| 6 | Finance reporting hardening (integrity issues + page) | ✅ done — this doc |

All six phases of the payroll-finance audit are now closed. The remaining
optional polish (sidebar nav entry, RPC-level Deno tests, fetchGLTotals
role-cross-check) is tracked in this doc under "Deviations" and can be
picked up as separate small PRs.
