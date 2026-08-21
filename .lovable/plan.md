# Currency & FX — authoritative status

Authority: ADR 0135 / 0136 / 0138. Scope boundary: FX source → settlement →
posting → FX engine → FX reporting. No second rate table, no second resolver,
no client-side conversion that posts, no unrelated module work.

## Completed and verified

### Phases 1–8 (earlier waves)
One rate book (`public.exchange_rates`), one server resolver
(`resolve_exchange_rate` / `require_exchange_rate`), one client lookup
(`@/services/fx/rateBook`). Booking, settlement, compensation and POS paths all
refuse a missing rate instead of posting at parity. Re-verified live this wave.

### Phase 9 — reversal symmetry — DONE
- `void_journal_entry_atomic` now carries `original_currency` / `exchange_rate`
  onto reversal lines, mirrors `original_debit` / `original_credit` to the
  opposite side, and the reversal header inherits the original currency + rate.
- `unapply_payment_atomic` mirrors the original settlement journal line-for-line
  (excluding the cash leg, which is reclassified to customer deposits), so the
  receivable is restored at the rate it was relieved at and any realised
  gain/loss is backed out. No rate is re-resolved on a reversal.
- AP reversals (`void_payment_atomic`, `void_bill_payment_atomic`,
  `unapply_vendor_credit_from_bill_atomic`) delegate to
  `void_journal_entry_atomic` and inherit the fix — verified, no duplicate
  reversal engine exists.
- Ratchet: `supabase/tests/fx_reversal_symmetry_test.sql` (read-only). All
  assertions re-checked live and hold.

### Phase 10 — honest absence in the open-item projections — DONE (this wave)
Root defect found and fixed: the canonical AR projection itself was inventing
rates, which is why downstream surfaces could show a confident wrong number.
- `finance_ar_open_items`: removed `COALESCE(NULLIF(exchange_rate,0), 1)` and
  the literal `'USD'`. `base_residual_amount` is now NULL for a foreign document
  with no stamped rate; a same-currency document still resolves to 1 (identity,
  not an invented rate).
- `finance_ar_net_position_by_currency`: `base_open_amount` / `base_net_amount`
  are NULL when any contributing document is unconvertible (previously a partial
  sum read as a complete total), plus a new `unconvertible_document_count`.
  `security_invoker` preserved.
- `raise_ar_dispute` / `record_promise_to_pay`: `'KES'` literals removed; the
  currency is derived from the business base currency and the write refuses when
  none is configured. `currency` column defaults `'KES'` dropped on
  `ar_disputes` and `ar_promises_to_pay`. Both already refused a missing rate.
- Client: `CurrencyNetPositionRow.baseNetAmount` is `number | null` and carries
  `unconvertibleDocumentCount`; Collections renders "No rate on file" linking to
  `/settings/company?tab=currency` instead of a coerced 0.
  `?? "KES"` removed from the dispute and promise mappers.
- Ratchet: `supabase/tests/fx_open_items_absence_test.sql` (read-only) — no
  parity fallback and no currency literal in any `finance_*` view, absence
  propagates through the per-currency aggregate, and both collections writers
  derive their currency and refuse a missing rate. Verified live: 0 offending
  views, both writers clean.
- `tsgo --noEmit`: clean. `vitest`: 44/44 pass across `fx-single-engine`,
  `disputes-work-queue`, `promise-to-pay`.
- Linter baseline unchanged at 3599 across all four migrations.

## Active phase

None — Phase 10 is closed. Phase 11 is the next milestone.

## Pending

### Phase 11 — isolation ratchet (NEXT)
Assert business/org scoping on the FX reporting surfaces: a member of Business A
must never resolve or read Business B's rates or exposure. Cover
`fx_exposure_by_currency`, `fx_exposure_open_items`, `fx_revaluation_readiness`
and `describe_exchange_rate`, and add the assertions to the architecture guard.

### Phase 12 — AP-side absence parity (after 11)
Phase 10 corrected the AR projections. Apply the same treatment to the payables
side (`finance_ap_open_items_as_of` and the vendor-credit/net-position
surfaces): no parity fallback, NULL propagation, an unconvertible count, and an
absence state in the vendor-facing UI.

### Phase 13 — `finance_open_items_tieout`
The only `finance_*` view still holding a currency literal; currently exempted
in the ratchet. Decide whether the literal is diagnostic-only and remove the
exemption.

## Carried limitations (documented, not defects)
- `payments` / `customer_credit_balances` carry no currency column: advances are
  structurally base-currency only. A schema change is out of scope without an
  explicit decision.
- Live `exchange_rates` holds base-currency rows only, so foreign paths are
  proven by catalogue tests and construction, not by exercised tenant data.
- The `.sql` suites under `supabase/tests/` cannot be executed from this
  environment (SELECT-only tooling); their catalogue assertions are re-run as
  read-only SELECTs instead. The DML fixtures inside them remain UNVERIFIED.
- Pre-existing unrelated failure: `bill-payment-allocations-first-class.test.ts`.
- Supabase binding is `jkszmrroyjfdwokbkzis`; attaching a different project
  would be a destructive re-bind and is out of scope.

## Instructions for the next agent
1. **Verify before extending.** Re-run `bunx vitest run
   src/test/architecture/fx-single-engine.test.ts` and re-check the Phase 9/10
   catalogue assertions live (the two `supabase/tests/fx_*` files list them).
   Confirm `finance_ar_open_items.base_residual_amount` really is NULL for an
   unstamped foreign document and that Collections renders the absence state.
2. **Do not trust this log over the database.** Every claim above was checked
   against the live catalogue at the time of writing; re-check rather than
   assume.
3. **Then resume at Phase 11**, not elsewhere. Finish each phase to a
   production-ready state — schema, engine, UI absence state and ratchet test —
   before starting the next.
