# Receivables & Partners Reporting — Investigation + Phased Remediation

Authoritative status document. Active phase, completed work and the next
milestone are all recorded here; update it at the end of every phase.

---

## Verified findings (independent trace)

**Engine shape.** `REPORT_REGISTRY` drives nav/routing; `ReportSurface`/`ReportTable` render.
- Aged Receivables / Aged Payables — SQL-driven via `get_ar_ap_aging_from_ledger`.
- Partner Ledger — pages raw rows out of `customer_ledger_entries` / `vendor_ledger_entries`
  and computes opening / running / closing balances **in JavaScript**, over an unbounded
  paging loop.
- Sales Reports — aggregates `invoices` client-side. Ignores credit notes, returns and
  multi-currency normalisation; hand-rolled export payload diverges from the report engine.

**Security (cleared).** `customer_ledger_entries`, `vendor_ledger_entries`,
`ar_subledger_entries`, `ap_subledger_entries` are all `security_invoker=on`, so the Partner
Ledger's direct client reads are scoped by RLS on `journal_entries` / `journal_entry_lines`
(business + branch + `financials.read`). No leak on that path.

---

## Phase 1 — Authorization hardening — ✅ COMPLETE (verified)

Problem: `get_control_account_reconciliation` and `get_ar_summary` were `SECURITY DEFINER`,
took `_org_id` from the caller and never checked membership — any signed-in user could read
another tenant's AR/AP control balance, sub-ledger total and drift. `get_ar_summary` was also
callable by `anon`.

Delivered:
- Membership gate (`finance_can_read_org`, `42501` on failure) in both functions.
  The reconciliation body was patched by injection, so its accounting logic is byte-identical.
- `anon` EXECUTE revoked on both; `authenticated` + `service_role` only.
- Verified in `pg_proc`/ACL: definer, gated, no anon.
- Test: `supabase/tests/receivables_reporting_authorization_test.sql`.

## Phase 2 — Receivables point-in-time parity — ✅ COMPLETE (verified)

Problem: AP had a point-in-time engine (`finance_ap_open_items_as_of`); AR read the
`finance_ar_open_items` view, which nets **all** receipts and credit notes regardless of date.
Aged Receivables for a past date silently reported today's residuals, so no closed period was
reproducible and customer statements re-rendered differently the next day.

Delivered (database):
- `finance_ar_open_items_as_of(_org, _business, _branch, _as_of)` — exact mirror of the
  payables engine. Invoice counts only once its AR control-account entry was posted by
  `_as_of`; receipts bounded by `payments.payment_date` and void date; credit notes bounded by
  application/issue date; manual AR journals folded in with FIFO settlement; FX per ADR
  0135/0136 (document rate → same-currency 1 → rate authority; never a fabricated 1:1).
  Deliberately does **not** exclude currently-`paid` invoices — residual is the only authority.
- `finance_ar_customer_credit_as_of(...)` — customer credit replayed from the append-only
  `customer_credit_movements` (the live `customer_credit_balances` cannot answer a past date).
- `finance_ar_aging_reconciliation(...)` — twin of the AP one; ties the aging total to the AR
  control account at the same date (AR is debit-balance: `debit - credit`).
- `get_ar_summary` and the AR branch of `get_ar_ap_aging_from_ledger` repointed at the engine;
  the summary's unposted-document probe is now `_as_of`-bounded too.
- All three new functions: definer + pinned `search_path` + org gate + no anon EXECUTE.

Delivered (application):
- `services/finance/openItems.ts` — added `fetchArOpenItemsAsOf` / `fetchArCustomerCreditAsOf`;
  `fetchContactOpenItemAging` now serves BOTH sides from their engine; 
  `fetchUnappliedCustomerCredit` takes an `asOf` and reads the as-of credit function. No
  remaining direct reads of the always-today AR views in the canonical access layer.

Tests:
- `supabase/tests/ar_aging_as_of_test.sql` — one definition each, hardening, "consumers read the
  engine and not the legacy views", `_as_of` genuinely bounds posting/receipts/credits, and
  cross-org calls raise `42501`.
- `src/test/architecture/ar-aging-point-in-time.test.ts` — 5 tests, passing.
- Existing `aging-single-source`, `reports-data-source-contract`,
  `sales-dashboard-projection` suites re-run: 29 tests passing.

---

## ▶ NEXT — Phase 3 — Partner Ledger balances in SQL (not started)

Current state: `src/pages/reports/PartnerLedger.tsx` pages every ledger row into the browser in
an unbounded loop and computes opening / running / closing balances in JavaScript, with no
base-currency normalisation and no as-of parameter on the views.

Scope:
1. `finance_partner_ledger(_org, _business, _branch, _contact, _side, _from, _to, _limit,
   _offset)` — returns opening balance, the paged movements with a SQL running balance, and the
   closing balance, all in base currency; gated with `finance_can_read_org`, no anon EXECUTE.
2. Repoint `PartnerLedger.tsx` at it through a typed hook; delete the JS paging/aggregation.
3. Export re-runs the query unpaged (the Aged Payables export pattern), never re-aggregates the
   visible page.
4. Tests: SQL contract test (single definition, hardening, opening + movements + closing tie to
   the control account) and an architecture ratchet that the page holds no `.reduce(` balance
   maths and no unbounded `range(` loop.

## Phase 4 — Sales Reports as a real accounting report (not started)

Rebuild on GL/dimensional sources including credit notes, returns and base-currency
normalisation; drop the bespoke export payload in favour of the report engine's.

---

## Instructions for the next agent

1. **Verify before building.** Confirm Phase 2 landed to enterprise standard before starting
   Phase 3:
   - `supabase/tests/ar_aging_as_of_test.sql` and
     `supabase/tests/receivables_reporting_authorization_test.sql` pass against the database.
   - `bunx vitest run src/test/architecture` is green.
   - Spot-check accounting truth on real data: for a business with history, 
     `finance_ar_aging_reconciliation(org, biz, NULL, <a past month-end>)` should report
     `in_balance = true`; a non-zero `variance` is a real finding — investigate it (missing
     control-account postings, FX rate gaps) rather than adjusting the report to match.
   - Confirm `get_ar_summary` and Aged Receivables return the SAME total for the same as-of
     date, and that an as-of date in the past no longer moves when re-run tomorrow.
2. **Then resume at Phase 3**, in the order written above. Do not start Phase 4, and do not pick
   up unrelated reporting work, until Phase 3 is complete end to end (SQL + page + export +
   tests).
3. **Keep this file current** — mark Phase 3 complete with what was verified before moving on.
