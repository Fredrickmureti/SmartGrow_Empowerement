# Currency & Forex — reporting trustworthiness programme

Authoritative status file. Update after every implementation step.
Origin plan: `.lovable/plan/currency-forex-reporting-findings-and-phased-execution-plan-2026-08-21.md`

## Where we are

- Phase 1 — Revaluation lifecycle repair: **COMPLETE, verified**
- Phase 2a — Posting engine denomination + AR invoice family: **COMPLETE, verified (catalog-level)**
- Phase 2b — Remaining document families: **NEXT**
- Phases 3–5: pending

---

## Phase 1 — Revaluation lifecycle repair (COMPLETE)

Implemented and verified:

- `reverse_fx_revaluation_run` — organisation now derived from the run row
  (`_run.organization_id`); the reference to the non-existent column
  `reversal_of_run_id` removed. Before this, every reversal raised at runtime,
  which also made the second and each later revaluation run fail.
- `revalue_fx_balances` — journal numbering delegated to the posting engine
  (ADR-0146, callers pass a NULL entry number); unrealized gain/loss posted at
  entity level (`branch_id = NULL`) instead of an arbitrary `MIN(branch_id)`.
- Guard: `supabase/tests/fx_revaluation_lifecycle_test.sql` — reversal
  identifiers resolve, no hand-built journal numbers, no branch guessing,
  period / permission / missing-rate gates intact, exposure RPCs remain
  SECURITY DEFINER + business-gated and not anon-executable.
- `src/test/architecture/fx-single-engine.test.ts` green (18 tests).

## Phase 2 — Denomination and eligibility

### Root cause confirmed (was worse than the original diagnosis)

1. `post_journal_entry_atomic` — the only journal writer — never wrote
   `original_currency` / `original_debit` / `original_credit`. Every FX report
   reading those columns was reading nothing.
2. Document posters pass **document-currency** amounts. `build_invoice_je_lines`
   builds the AR debit from `invoices.total`; `_confirm_invoice_core` posted it
   with `_currency := v_inv.currency` and no rate. A foreign invoice therefore
   entered the general ledger unconverted — a GL integrity defect, not merely a
   reporting one.

### Phase 2a — posting engine becomes the denomination authority (COMPLETE)

- `post_journal_entry_atomic` gained `_amounts_in_document_currency boolean
  DEFAULT false`. When a caller opts in and the document currency differs from
  `businesses.base_currency`, the engine:
  - resolves the rate via `require_exchange_rate` (raises on a missing rate —
    never a silent 1:1, ADR 0136);
  - stores base-currency `debit`/`credit` and stamps `original_currency`,
    `original_debit`, `original_credit`, `exchange_rate` on every line;
  - validates balance in document currency *and* in base currency, absorbing
    the per-line rounding residual on the largest line;
  - stamps the header currency and rate.
- Default `false` keeps every unmigrated caller byte-identical in behaviour.
  Base-currency entries keep full amount precision (no forced 2dp rounding).
- The superseded 17-argument overload was dropped (two overloads would have made
  every named-argument call ambiguous); `EXECUTE` revoked from PUBLIC/`anon`,
  granted to `authenticated` and `service_role`.
- First document family migrated: **AR invoices** (`_confirm_invoice_core`),
  patched surgically from the live definition so no unrelated logic drifted.
- Guard: `supabase/tests/journal_denomination_contract_test.sql` — exactly one
  engine overload, opt-in exists and defaults to false, original_* stamping,
  resolver use, base-balance assertion, residual handling, no rate literal,
  no anon EXECUTE, and the invoice family declares its denomination.

### Phase 2b — remaining document families (NEXT)

Migrate one family per step, each with a contract-test assertion appended to
`supabase/tests/journal_denomination_contract_test.sql` section 4:

1. AP bills — `confirm_bill_atomic` currently passes **no** `_currency`, so a
   foreign bill is recorded as base. Pass `bills.currency` + the opt-in.
2. Credit notes — `issue_credit_note_atomic`, `issue_vendor_credit_note_atomic`
   (both already pass a document currency; add the opt-in).
3. Delivery/goods paths — `complete_delivery_atomic`, `finance_post_gr_journal`,
   `_landed_cost_post_apply`.
4. Deliberate, non-inferred review of the settlement paths that already do their
   own base/foreign handling — `record_multi_invoice_payment`,
   `record_multi_bill_payment`, `bank_match_confirm`. These must NOT be flipped
   blindly: confirm whether their lines are already base before opting in.
5. Then the eligibility model: line-level `original_currency` grouping in
   `revalue_fx_balances` / `fx_exposure_by_currency`, and a monetary-account
   filter so inventory and other non-monetary balances stop being revalued.

## Phase 3 — Realized FX gain/loss report (pending)
## Phase 4 — Exposure dimensions (by account, by counterparty) (pending)
## Phase 5 — Rate register / provenance surface (pending)

---

## Instructions for the next agent

1. **Verify Phase 2a before writing anything new.**
   - `select count(*) from pg_proc … proname='post_journal_entry_atomic'` must
     return 1, and its arguments must end with
     `_amounts_in_document_currency boolean DEFAULT false`.
   - Run `supabase/tests/journal_denomination_contract_test.sql` and
     `supabase/tests/fx_revaluation_lifecycle_test.sql`.
   - Behavioural check still outstanding: post one base-currency document and one
     foreign-currency document in a scratch business and confirm (a) the base
     document is unchanged versus before, (b) the foreign document's lines carry
     `original_*` and base amounts equal `original × rate`, (c) a foreign document
     with no rate on file fails loudly. Do this before migrating more families.
2. **Then resume at Phase 2b step 1 (AP bills).** Do not jump to Phases 3–5;
   the reports cannot be made trustworthy while document families still post
   foreign amounts unconverted.
3. Migrate call sites by surgically patching `pg_get_functiondef` output inside
   the migration (see the Phase 2a migration) rather than retyping large function
   bodies.
4. Keep this file current after each step.
