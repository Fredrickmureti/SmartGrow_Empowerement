# Currency & Forex reporting — findings and phased execution plan

Scope: FX reporting only (`/finance/reports/fx-revaluation`, `/finance/reports/fx-exposure`) plus the FX
infrastructure those reports derive truth from. No other ERP domain is touched.

## Verdict

The two existing categories are **C + D**: architecturally sound as projections (one resolver, one rate book,
server-side computation, honest missing-rate handling), but the *denomination model underneath them is wrong*,
the revaluation reversal path is **non-functional**, and the domain is missing the one report an accountant
actually needs first — **realized FX** and the **rate register/provenance** view. "Exposure" as implemented is a
foreign-currency balance listing derived from the entry header currency, not an exposure analysis.

## Verified facts (read from code and the live database)

Correct — do not disturb:
1. One rate book (`public.exchange_rates`) and one resolver (`resolve_exchange_rate`), precedence
   business-scoped > effective_date desc > override/manual/provider > published_at. Returns NULL, never 1.
2. `require_exchange_rate` raises rather than posting unconverted; `fx_stamp_document` is the single stamper.
3. Both exposure RPCs and `fx_revaluation_readiness` are SECURITY DEFINER, gate on
   `user_can_access_business(auth.uid(), _business_id)`, and are granted to `authenticated`/`service_role`
   only — **no anon EXECUTE**. Business isolation on the FX read path is enforced server-side.
4. `revalue_fx_balances` requires `finance.manage_periods`, refuses a non-open fiscal period, refuses a second
   posted run in the same period, validates gain/loss accounts belong to the business, and posts only via
   `post_journal_entry_atomic`. Journals are balanced by construction.
5. Both pages use the shared reporting surface (`ReportSurface`/`ReportTable`/`ReportExportService`); no second
   reporting engine, no client-side rate math. `fx-single-engine.test.ts` guards this.
6. `exchange_rates` RLS: `user_can_access_business(auth.uid(), business_id)`; all 130 live rows are
   business-scoped, single org.

Defects — verified:
7. **Reversal is dead code that always throws.** `reverse_fx_revaluation_run` references `_org_id`, which is
   neither a parameter nor declared, and `f.reversal_of_run_id`, a column that does not exist on
   `fx_revaluation_runs` (columns confirmed). Consequence: no revaluation can ever be reversed, and because
   `revalue_fx_balances` calls it to reverse the prior period's run, **the second and every later revaluation
   run in a business fails**. Currently masked only because `fx_revaluation_runs` is empty (0 rows).
8. **Denomination is taken from the journal header, not the line.** Every FX query groups on `je.currency` and
   derives the foreign amount from `COALESCE(jel.original_debit, jel.debit)`. `journal_entry_lines` already
   carries `original_currency` and `exchange_rate` per line, and **0 of 28 lines currently populate
   `original_*`** — so today the fallback would treat a *base* amount as a *foreign* amount and revalue it at
   the full rate. Any mixed-currency entry (foreign invoice settled into a base bank account) mis-attributes
   base-denominated lines to the foreign currency bucket.
9. **Monetary/non-monetary is not modelled.** Eligibility is `account_type IN ('asset','liability')` only.
   Inventory, prepayments, fixed assets, deposits paid are assets and would be revalued — IAS 21 requires
   non-monetary items to stay at historical rate. `accounts` has no currency and no monetary flag.
10. **Account-grain netting hides realized residue.** Revaluation aggregates per (account, currency) and skips
    rows whose *foreign* balance nets to ~0. A fully settled foreign item that left a base-currency residue on
    the control account is therefore invisible and never reconciled. No open-item (invoice/bill-level)
    revaluation grain exists.
11. **Realized FX has no report and only two producers.** `resolve_fx_realized_account` is called only by
    `record_multi_invoice_payment` and `record_multi_bill_payment`. Other settlement paths (credit-note
    application, refunds, bank write-offs, advances) were not verified to book realized FX — flagged for Phase 2
    verification, not asserted.
12. **Journal numbers are hand-built.** Both FX functions compose `FXREV-YYYY-NNNN` from `count(*)` and pass it
    to `post_journal_entry_atomic`, violating ADR-0146 (callers pass NULL) and racing under concurrency.
13. **Branch attribution is arbitrary.** The gain/loss lines take `MIN(jel.branch_id)`. The pages correctly
    declare FX as entity-level; the posting should then use a deterministic entity-level branch (NULL), not MIN.
14. **Latent client/server rate asymmetry.** `resolve_exchange_rate` reads org-level rows (`business_id IS NULL`)
    but RLS hides them from the browser, so the client rate book and the server resolver can disagree once the
    platform publisher writes org-level rows. Zero such rows today.
15. **No rate register report.** No surface answers "which rate, from where, effective when, superseded by
    what" — `describe_exchange_rate` exists and is `EXECUTE PUBLIC` (over-granted).

## Report model (target)

Four surfaces, not ten:
- **FX Exposure** (exists) — open foreign monetary position by currency, split AR/AP/cash/other, with
  open-item drill-down. Add dimensions: by account, by counterparty, at a selected what-if rate.
- **FX Revaluation** (exists) — run register + per-account before/after + posted journal, with reversal.
- **Realized FX gain/loss** (new) — settlement-driven, per document/counterparty/currency/period, tying to the
  realized gain/loss accounts. This is the report accountants ask for first and it is absent.
- **Exchange-rate register** (new, small) — rate history with source/provider/effective date/supersession.

Everything else (by customer, by vendor, by account, by period, by branch) is a **dimension/filter/drill-down**
on the four, not a new page.

## Phases

Phase 1 — Fix the broken revaluation lifecycle (blocking, no new UI)
- Repair `reverse_fx_revaluation_run`: derive org from the run row, drop the non-existent column reference,
  pass NULL entry numbers per ADR-0146 (same for `revalue_fx_balances`).
- Deterministic entity-level branch on FX journal lines.
- Tests: reverse a posted run; run revaluation in two consecutive periods; idempotency (second run in same
  period rejected); reversal of a nil run; locked-period rejection; numbering under concurrency.

Phase 2 — Correct the denomination and eligibility model (accounting core)
- Move all FX scope queries onto `jel.original_currency` + `jel.exchange_rate` (line grain), with a strict
  guard that a foreign line without `original_currency` is an error, not a silent base-as-foreign fallback.
- Introduce an explicit monetary-account determination (detail_type based, extensible) and exclude
  non-monetary assets from revaluation and exposure.
- Backfill/verify `original_*` population on all posting paths that stamp a foreign currency.
- Verify every settlement path books realized FX; list the gaps as their own sub-steps.
- Tests: mixed-currency entry attribution, non-monetary exclusion, partial/multiple settlement, invoice-rate vs
  payment-rate, revaluation→settlement, revaluation→revaluation, reversal/void, credit notes, advances.

Phase 3 — Realized FX report
- Server-side projection over settlement postings (same resolver, same scoping helper, no new engine),
  by currency / counterparty / document / period, reconciling to the realized gain/loss account balances.
- Shared reporting surface + export. RPC gated on `user_can_access_business`, `authenticated` only.

Phase 4 — Exposure dimensions + control tie-out
- Add account and counterparty grouping and a what-if reporting rate to the existing exposure RPCs.
- Add a residual/control tie-out: (account, currency) rows with zero foreign balance but non-zero base residue.

Phase 5 — Rate register + provenance hardening
- Small register report over `exchange_rates`; tighten `describe_exchange_rate` EXECUTE from PUBLIC to
  `authenticated`; align RLS so org-level rows the resolver honours are also visible to the client reader.

Dependencies: Phase 2 depends on Phase 1 (reversal must work before re-running with corrected scope).
Phases 3–5 depend on Phase 2's denomination model. Phase 5 is independent of 3–4 and may run in parallel.

## Cross-cutting test requirements
Accounting invariants (balanced journals, unrealized never accumulates across runs, revaluation + realized ties
to the movement in the FX accounts), multi-business isolation on every new RPC (user of Business A gets 42501
for Business B), branch scoping assertions, missing-rate = absence (never 1:1), period-lock, year-end,
export/PDF parity with the on-screen table.

## Scope boundaries
No changes to `resolve_exchange_rate` precedence, `post_journal_entry_atomic`, the reporting infrastructure, or
any non-FX report. No new FX calculation anywhere in the client. No new reporting engine.

---

## Execution status — 2026-08-21

### Phase 1 — COMPLETE
- `reverse_fx_revaluation_run` repaired: organisation derived from the run row
  (`_run.organization_id`), the non-existent `reversal_of_run_id` reference removed.
  Reversal — and therefore every revaluation run after the first — used to fail at runtime.
- `revalue_fx_balances` repaired: journal numbering delegated to
  `post_journal_entry_atomic` (ADR-0146), unrealized gain/loss posted at entity level
  (`branch_id = NULL`) instead of an arbitrary `MIN(branch_id)`.
- Guard added: `supabase/tests/fx_revaluation_lifecycle_test.sql` (catalog assertions for
  the reversal identifiers, no hand-built numbers, no branch guessing, period/permission/
  missing-rate gates, SECURITY DEFINER + business gate on the read RPCs).
- `src/test/architecture/fx-single-engine.test.ts` still green (18 tests).

### Phase 2 — blocked on a decision, root cause now confirmed
The denomination defect is deeper than "group by header currency":

1. `post_journal_entry_atomic` — the only journal writer — never writes
   `original_currency`, `original_debit`, `original_credit`. Those columns are
   effectively always NULL, so every FX report that reads them is reading nothing.
2. Document posters pass **document-currency** amounts as if they were base amounts.
   `build_invoice_je_lines` builds the AR debit from `invoices.total` (document
   currency) and `_confirm_invoice_core` posts it with `_currency := v_inv.currency`
   and `_exchange_rate := NULL`. `confirm_bill_atomic` does not pass a currency at all,
   so a foreign bill is recorded as base.

Consequence: a foreign-currency document enters the ledger unconverted. Trial balance,
P&L and every FX report are wrong the moment a non-base document is posted — this is
a general-ledger integrity defect, not only a reporting one.

The fix is a posting-engine change: `post_journal_entry_atomic` must accept
document-currency line amounts, resolve the rate through `require_exchange_rate`,
stamp `original_*` per line and store base amounts, with a rounding residual applied to
keep the entry balanced. Blast radius: ~50 caller functions, of which a few
(`record_multi_invoice_payment`, `record_multi_bill_payment`, `bank_match_confirm`)
already do their own base/foreign handling and must be migrated deliberately rather
than inferred. Recommended sequencing: engine gains an explicit opt-in flag (default
preserves today's behaviour), then callers migrate one document family at a time with a
SQL contract test each.
