# Ledgers & Journals — Reporting Domain Roadmap

Authoritative status file. Update after every implementation.

## Currently active phase

**Phase 7 — Audit gaps. 7.1 complete and verified. 7.2 implemented but not
proven. Next work: fix the failing architecture assertion (7.2a), then execute
the SQL suite (7.2b), then 7.3.**

## Verification pass (this session, independent of prior notes)

Checked directly against the live database and the codebase:

- `get_general_ledger` is `SECURITY DEFINER`, `search_path`-pinned, gated by
  `finance_can_read_org`, validates business↔org and branch↔org/business
  ownership, filters by `ledger_visible_journal_statuses()` (drafts stay
  invisible), scopes strictly on `_branch_id`, and returns `journal_entry_id`
  plus `original_debit` / `original_credit` / `exchange_rate`. Zero-activity
  rule is `_include_zero_activity OR line_id IS NOT NULL OR opening <> 0`.
- `get_general_ledger` no longer computes its own opening: it selects from
  `get_ledger_opening_balances(_org_id, _business_id, _date_from, _branch_id)`.
- `get_ledger_opening_balances` exists with the intended semantics: nominal
  (income/expense) accounts restart at the fiscal-year start derived from
  `businesses.fiscal_year_start`; prior closed years' net result is added to
  the retained-earnings account (explicit `default_account_settings` binding
  first, then `detail_type = 'retained_earnings'`); `accounts.opening_balance`
  is suppressed when `_branch_id` is not null.
- `supabase/functions/_shared/reportDataEngine.ts` calls the same RPC for
  opening balances, so the edge/PDF path and the screens share one rule.

So the previous engineer's Phase 7.2 code claim is accurate. Two things are
**not** true of the current state:

1. `src/test/architecture/ledger-reports-single-source.test.ts` is RED
   (1 of 22 failing). The assertion "a branch-scoped run must not add the
   business-level opening balance" still greps the edge engine for the old
   `branchId ? 0 :` client-side hack. That hack was correctly deleted when the
   suppression moved into the RPC — the test is stale, the code is right.
2. The new SQL assertions were never executed. This sandbox has no `PGHOST`
   and the query tool is read-only, so `supabase/tests/ledger_reports_engine_test.sql`
   sections H/I remain unproven.

## Completed and verified

### Phase 5 / 5A — Unified reporting engine and parity proof
Trial Balance, General Ledger and Journal Report read exactly three server
engines: `get_account_movements`, `get_general_ledger`, `get_journal_report`.
All `SECURITY DEFINER`, `search_path`-pinned, `anon`-revoked, gated by
`finance_can_read_org`, scoped by organization, business and branch.

### Phase 6 — Multi-currency presentation
`debit` / `credit` are base currency and are the sole authority for totals,
running balances and tie-outs. Foreign-currency values (Currency · Document
Amt · Rate) are supplementary and appear only when the run holds a foreign
line, on screen and in PDF/CSV/XLSX. Trial Balance stays base-currency only.

### Phase 7.1 — Drill-through consistency
One rule for all three surfaces: a movement drills into its source document
when it has one, otherwise into the journal entry that created it. Shared
resolver `src/lib/reports/ledgerDrillTarget.ts`; no browser-side
`journal_entry_lines` reads; Trial Balance drill-down inherits `branchId`.

## Pending

### 7.2a — Repair the stale opening-balance assertion (do first)
Replace the `branchId ? 0 :` grep in
`src/test/architecture/ledger-reports-single-source.test.ts` with assertions
that match the architecture as it now is:
- the edge engine and the ledger RPCs obtain openings only from
  `get_ledger_opening_balances` (no local opening arithmetic, no
  `accounts.opening_balance` read used as an opening figure in TS);
- `_branch_id` is threaded into that RPC call.
Suite must return 22/22 green.

### 7.2b — Execute the fiscal-year SQL suite
Run `supabase/tests/ledger_reports_engine_test.sql` sections H/I through a
write-capable path (a transactional migration that runs the fixtures and
raises on assertion failure, rolled back at the end): fiscal-year reset for
nominal accounts, retained-earnings absorption, opening trial balance
balancing (Σ debit openings = Σ credit openings), GL-vs-opening-engine parity,
zero-activity inclusion semantics. Only then is 7.2 verified.

### 7.3 — Branch-scoped opening semantics and comparison periods
- Prove that a branch-scoped opening equals the branch's own prior movement
  with no share of the business-level `accounts.opening_balance`, and state
  that rule in the report masthead so an accountant is not surprised.
- Retained-earnings absorption currently uses the branch filter as well;
  confirm a branch run should carry only that branch's prior-year result, or
  suppress it, and pin the decision with a test.
- Comparative-period parity: screen, PDF and Trial Balance must agree on the
  comparison window's opening and closing figures.

### Phase 8 — Not started
Scheduled ledger deliveries and archive retention review.

## Instructions for the next agent

1. Start at 7.2a. Do not touch the RPCs to make the test pass — the RPC is
   correct; the assertion is out of date.
2. Then 7.2b, then 7.3. Bring each item to a production-ready state — schema,
   engine, screen, export and tests — before moving to the next.
