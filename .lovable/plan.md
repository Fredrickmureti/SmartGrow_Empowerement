# Ledgers & Journals — Reporting Domain Roadmap

Authoritative status file. Update after every implementation.

## Currently active phase

**Phase 6 — Multi-currency presentation: COMPLETE (pending live visual check on a
multi-currency dataset).** Next agent starts at Phase 7.

## Completed and verified

### Phase 5 — Unified reporting engine (verified by audit, not by me originally)
- Trial Balance, General Ledger and Journal Report read exactly three server
  engines: `get_account_movements`, `get_general_ledger`, `get_journal_report`.
- All three RPCs are `SECURITY DEFINER`, `search_path`-pinned, `anon`-revoked,
  gated by `finance_can_read_org`, and scoped by organization, business and branch.
- Screen and archived PDF share the same engine — no second accounting path.

### Phase 5A — Numerical parity & isolation proof (COMPLETE)
- `supabase/tests/ledger_reports_engine_test.sql`: security/catalog contracts,
  draft exclusion, reversal visibility, strict branch scoping, opening + movement
  = closing algebra, pagination completeness, tenant isolation.
- `src/test/architecture/ledger-reports-single-source.test.ts`: single-source
  guard (13 tests, passing).
- Fixed during 5A: `buildPartnerLedger` was querying raw tables; it now routes
  through the `finance_partner_ledger` RPC with `branchId` support.

### Phase 6 — Multi-currency presentation (COMPLETE)
The rule, now enforced in code and by tests:
> `debit` / `credit` are base currency and are the sole authority for every
> total, running balance and tie-out. Foreign-currency values are a supplement
> recording what the source document said, and never enter arithmetic.

- RPCs `get_general_ledger` and `get_journal_report` return `original_debit`,
  `original_credit`, `exchange_rate` (migration applied).
- Shared presentation rule mirrored in both runtimes:
  `src/lib/reports/currencyPresentation.ts` (Vite) and
  `supabase/functions/_shared/reports/currencyPresentation.ts` (Deno).
- General Ledger and Journal Report show three supplementary columns —
  Currency · Document Amt · Rate — **only** when the run contains a
  foreign-currency line, on screen and in the PDF/CSV/XLSX.
- Masthead states "Amounts in <BASE> (base currency)" whenever the supplement
  is shown.
- Trial Balance deliberately gains no FX columns (mixed units cannot balance);
  locked by test.
- `ReportResult.columns` added: ledger builders widen their own column set and
  `render-report` now threads it into `renderReport` for the PDF path.

## Pending

### Phase 7 — Audit gaps (NEXT)
1. **Drill-down consistency** — General Ledger opens a preview drawer on the
   source document; Journal Report and Trial Balance behave differently. Make
   drill-through identical across the three ledger screens.
2. **Fiscal-year boundary behaviour** — opening balances at a fiscal-year start
   must respect year-end closing entries; verify and cover with SQL tests.
3. **Zero-balance / zero-activity accounts** — `_include_zero_activity`
   semantics must match between screen, PDF and Trial Balance.

### Phase 8 — Not started
Scheduled ledger deliveries and archive retention review.

## Instructions for the next agent

1. **Verify Phase 6 before extending it.** Run
   `npx vitest run src/test/architecture/ledger-reports-single-source.test.ts`
   (expect 13 passing) and execute `supabase/tests/ledger_reports_engine_test.sql`.
   Then confirm on a business with a foreign-currency journal entry that the GL
   and Journal screens show Currency/Document Amt/Rate, that totals stay base
   currency, and that the exported PDF carries the same columns.
2. **Then resume at Phase 7, item 1** (drill-down consistency). Do not start
   unrelated work, and bring each item to a production-ready state — schema,
   engine, screen, export and tests — before moving to the next.
