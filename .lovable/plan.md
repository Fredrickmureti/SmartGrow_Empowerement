# Currency & FX — handover verification verdict, then producer-contract convergence

Last updated: 2026-08-21. Authority: ADR 0135 / 0136 / 0138.
Legend: **[V]** verified fact (code/DB evidence this session) · **[A]** accounting principle ·
**[I]** inference · **[R]** research-based.

## 1. Verification of the previous engineer's claims

Re-checked live against `pg_proc` / `pg_trigger` / the codebase, not the log.

| Claim | Verdict |
| --- | --- |
| Phase C — `resolve_fx_account` + realized/unrealized wrappers, `revalue_fx_balances` derives base currency from `businesses.base_currency`, rejects caller value and caller-supplied FX accounts | **[V] True.** Bodies confirm the entity-base derivation, the two `23514` raises and the central account resolution. |
| Phase D — `fx_exposure_dimensions`, `SECURITY DEFINER`, `user_can_access_business`, `EXECUTE` not granted to anon | **[V] True.** ACL = `postgres, authenticated, service_role` only. Same for `fx_exposure_by_currency`, `describe_exchange_rate`, `list_business_active_currencies`, `resolve_*`, `fx_stamp_document`. |
| Phase E — base-currency seed + `_bac_protect_base_currency` + `list_business_active_currencies`; `_expenses_derive_base_amount` lost its `count(*)` hatch | **[V] True.** The expense trigger now raises `22023` unconditionally for a non-enabled currency; the single business carries exactly one enabled row matching its `KES` base. |
| Guard suite "25 passing" | **[V] True.** `bunx vitest run src/test/architecture/fx-single-engine.test.ts` → 25 passed. |
| F4 — settings no longer free-text currency | **[V] True.** `CurrencySettings.tsx` selects from the `currencies` catalogue and writes only via `set_business_active_currency` / `set_exchange_rate_override`. |
| "Nothing is half-built; only Steps 7–8 pending" | **[V] False.** The prior waves audited AR, expenses and landed cost. Four producer/settlement defects below were never in scope and are still live. |

Invalidated assumption: the audit scope was treated as complete because the
*engine* is sound. The engine is sound; several **producers and settlement paths**
are not.

## 2. New critical findings (all [V] with the evidence noted)

**C1 — `convert_po_to_bill_atomic` is a second FX engine with silent parity.**
It reads `public.exchange_rates` directly (`ORDER BY effective_date DESC LIMIT 1`,
`CURRENT_DATE`, no `source` precedence) and then `v_rate := COALESCE(v_rate, 1)`,
writing `bills.currency_rate` / `company_currency_total`.
Mitigating [V]: `trg_bills_stamp_currency` is **BEFORE INSERT** and unconditionally
re-stamps through `fx_stamp_document`, so the wrong rate is overwritten today.
Consequence: dead-but-loaded gun — duplicate engine, wrong-date rate, parity
fallback, and a `company_currency_total` computed twice. Must be deleted, not kept.

**C2 — applying a credit note to an invoice never realizes FX.**
`apply_credit_to_invoice_atomic` posts both legs (customer-credit debit, AR credit)
at `v_cn.currency` with `_exchange_rate := NULL`, i.e. the *credit note's* rate.
[A] Settling a foreign monetary receivable with a credit issued at a different rate
realizes an FX gain/loss; AR must be relieved at the invoice's booking rate.
Consequence: AR sub-ledger and GL diverge in base currency by the rate delta, and
realized FX is understated. Compare the correct pattern in
`record_multi_invoice_payment` (relieves each invoice at `invoices.exchange_rate`,
computes `v_fx_delta`, posts to `resolve_fx_realized_account`).

**C3 — refunds and vendor refunds have no realized-FX leg and carry a currency literal.**
`refund_customer_atomic` falls back to `'KES'` twice when the source has no currency
and never resolves a refund-date rate; `refund_from_vendor_atomic` is the same shape.
[V] Neither references `resolve_fx_realized_account`.
[A] A refund settles a monetary liability at the refund-date rate → realized FX.
Consequence: hardcoded currency (ADR 0136 violation) plus unrecognised realized FX.

**C4 — settlement rate is caller-supplied.**
`record_multi_invoice_payment` / `record_multi_bill_payment` accept `_exchange_rate`
and prefer it over `resolve_exchange_rate` (`COALESCE(_exchange_rate, resolve…)`).
[V] `useGLPosting.ts:255` and `useVendorCreditNotes.ts:214` pass rates from the browser.
[A]/ADR 0136 §4: booking and settlement rates are stamped server-side; the browser may
display a rate, never determine a posted amount.

**C5 — advances and POS.** `record_advance_payment`, `record_vendor_advance_payment`,
`apply_vendor_advance_atomic` mention no currency or rate at all [V]; a foreign-currency
advance is a monetary item [A] and its application at a later rate realizes FX.
`pos_payment_session_open` takes `p_fx_rate` from the client with `COALESCE(p_fx_rate,1)` [V].
Classification of these as in-scope defects is **unverified** until their journal impact
is traced (Phase 1 below).

**C6 — minor.** `set_business_active_currency` carries an `anon` EXECUTE grant. It
fails closed on `auth.uid() IS NULL` [V], so this is hygiene, not a hole.

Not defects: `resolve_sales_exchange_rate` is a one-line delegation; the bill /
credit-note / VCN / purchase-return / PO / SO / estimate / landed-cost stampers all
route through `fx_stamp_document` (BEFORE triggers, verified in `pg_trigger`).

## 3. FX contract (the invariant set to enforce)

1. Denomination is authoritative on the **business document** (`currency`) and is
   frozen with the document's rate by the BEFORE stamper.
2. The **booking rate** is `fx_stamp_document` → `require_exchange_rate` on the
   document date. No caller, browser or otherwise, supplies it.
3. The **settlement rate** is `resolve_exchange_rate` on the settlement date, server-side.
4. Relief of a monetary balance is always at the **original booking rate**; the delta
   against the settlement rate is realized FX to `resolve_fx_realized_account`.
5. A missing rate raises. There is no `COALESCE(rate, 1)` and no currency literal.
6. Journal lines carry `original_currency` / `original_debit` / `original_credit`;
   `post_journal_entry_atomic` is the only converter.

## 4. Execution order (dependency-derived)

- **Phase 1 — finish the producer map (investigation, no code).** Trace advances, POS
  settlement, `bank_match_confirm`, `approve_sales_return_atomic`,
  `purchase_return_raise_credit`, `expense_reimburse_direct` and write-offs to their
  journal lines; record for each whether a foreign monetary balance is relieved and at
  which rate. Promote or drop C5 on the evidence.
- **Phase 2 — C1.** Delete the hand-rolled lookup in `convert_po_to_bill_atomic`; let the
  stamper own currency/rate/`company_currency_total`.
- **Phase 3 — C4.** Remove `_exchange_rate` from the settlement RPC signatures and from
  the two client call sites; resolve server-side only.
- **Phase 4 — C2 then C3.** Give credit application, customer refunds and vendor refunds
  the same relieve-at-booking-rate + realized-FX-delta shape as the payment engines.
  One shared helper (`_settle_monetary_leg`) rather than three copies.
- **Phase 5 — whatever Phase 1 promotes** (advances / POS / bank match).
- **Phase 6 — Step 7 carry-over.** Realized-FX vs GL tie-out, provable once Phase 4 seeds
  a foreign settlement fixture.
- **Phase 7 — Step 8 carry-over.** Period-close interlock on a currency with no rate.

## 5. Tests required

- SQL (`supabase/tests/`): cross-rate credit application posts a realized-FX line and
  leaves AR base-balanced; a foreign refund with no rate raises instead of using `'KES'`;
  `convert_po_to_bill_atomic` never reads `exchange_rates`; realized-FX report ties to GL.
- Guards (`src/test/architecture/fx-single-engine.test.ts`): no client call site may pass
  `_exchange_rate`; no `COALESCE(<rate>, 1)` in any posting path.
- Isolation: every new/edited RPC keeps `user_can_access_business` and
  `authenticated`-only EXECUTE; drop the `anon` grant on `set_business_active_currency`.

## 6. Scope boundary

FX source → settlement → posting → FX engine → FX reporting only. No reporting-engine
rewrite, no new rate table, no second resolver, no client-side conversion, no unrelated
module work.

## 7. Status

Verification complete. No implementation performed this wave. Awaiting approval to start
Phase 1.
