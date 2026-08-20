# Receivables & Partners Reporting — Investigation + Phased Remediation

## Verified findings (independent trace, not taken on trust)

**Engine shape.** `REPORT_REGISTRY` drives nav/routing; `ReportSurface`/`ReportTable` render.
- Aged Receivables / Aged Payables — SQL-driven via `get_ar_ap_aging_from_ledger`. Correct shape.
- Partner Ledger — pages raw rows out of `customer_ledger_entries` / `vendor_ledger_entries` and
  computes opening / running / closing balances **in JavaScript**, over an unbounded paging loop.
- Sales Reports — aggregates `invoices` client-side. Ignores credit notes, returns and
  multi-currency normalisation; hand-rolled export payload diverges from the report engine.

**Accounting asymmetry.** AP has a point-in-time engine (`finance_ap_open_items_as_of`);
AR reads a plain `finance_ar_open_items` view that is implicitly "today". Partner-ledger views
carry no base-currency columns and no as-of parameter.

**Security (critical).** `get_control_account_reconciliation` was `SECURITY DEFINER`, granted to
`authenticated`, and never checked membership on the caller-supplied `_org_id` — a signed-in user
of any tenant could read another tenant's AR/AP control balance, sub-ledger total and drift.
`get_ar_summary` had the same hole and was additionally executable by `anon`, reading the
owner-run `finance_ar_open_items` view.

**Security (cleared).** `customer_ledger_entries`, `vendor_ledger_entries`, `ar_subledger_entries`,
`ap_subledger_entries` are all `security_invoker=on`, so the Partner Ledger's direct client reads
are scoped by RLS on `journal_entries` / `journal_entry_lines` (business + branch + module
permission). No leak on that path.

## Phase 1 — Authorization hardening — DONE

- `get_control_account_reconciliation`: membership gate injected; body otherwise untouched.
- `get_ar_summary`: restated as gated `SECURITY DEFINER` plpgsql, mirroring `get_ap_summary`;
  query logic unchanged.
- `anon` EXECUTE revoked on both; `authenticated` + `service_role` only.
- Regression test: `supabase/tests/receivables_reporting_authorization_test.sql` asserts, for the
  whole AR/AP read family, single overload + definer + pinned search_path + `finance_can_read_org`
  in the body + no anon execute + foreign-org calls raising 42501, and that the four ledger views
  stay invoker-run.

## Phase 2 — AR point-in-time parity (next)

Give AR the payables engine's shape: `finance_ar_open_items_as_of(_org, _business, _branch, _as_of)`
derived from posted journal lines, then repoint `get_ar_summary` and Aged Receivables at it so an
as-of date produces the same number on every surface. Unblocks trustworthy statements and dunning.

## Phase 3 — Partner Ledger balances in SQL

Replace the JS paging/running-balance loop with an RPC returning opening balance, paged movements
and closing balance in base currency, gated the same way.

## Phase 4 — Sales Reports as a real accounting report

Rebuild on GL/dimensional sources including credit notes, returns and base-currency normalisation;
drop the bespoke export payload in favour of the report engine's.
