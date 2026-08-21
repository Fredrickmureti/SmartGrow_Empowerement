# Currency & FX — handover verification verdict, then Phase 8+

Authority: ADR 0123 (posting monopoly), ADR 0135/0136 (one FX engine, no silent
parity), IAS 21 (monetary items). Legend: **[VF]** verified fact (live DB / code),
**[AP]** accounting principle, **[INF]** inference, **[UNV]** unverified.

## Verification of the previous engineer's Phase 7 claims

Re-derived from `pg_get_functiondef` on the live database, not from the log.

Confirmed true **[VF]**:
- `fx_revaluation_readiness`: no `businesses.default_currency`; uses
  `fx_is_monetary_account`, `journal_entry_lines.original_currency`, and
  `resolve_exchange_rate`. It is a projection of the engine, as claimed.
- `revalue_fx_balances`: monetary classifier + line currency + single resolver, no
  `COALESCE(rate, 1)`.
- `post_expense_gl`: parity fallback genuinely removed.
- `purchase_return_create`: resolves through `require_exchange_rate`.
- Phase 8's six reporting offenders are real and still carry
  `COALESCE(NULLIF(rate,0),1)`: `finance_purchase_analysis`,
  `finance_purchase_expense_reconciliation`, `finance_sales_analysis`,
  `finance_sales_revenue_reconciliation`, `get_salesperson_performance`,
  `get_salesperson_performance_documents`.
- `journal_entry_lines` carries the full FX quintet (`original_currency`,
  `original_debit`, `original_credit`, `exchange_rate`) and
  `post_journal_entry_atomic` writes them.
- UI claim in the prompt is **invalidated** for the rate-override dialog:
  `CurrencySettings` already picks the currency from the `currencies` catalogue via
  a Select, with the base as a locked target. No free-text currency there.

Invalidated **[VF]** — the Step 4 claim "zero posting/settlement/document engine
carries a parity fallback" and "only one client/server rate lookup" are **false**:

1. **`public.to_base_amount` is a second FX engine with a silent 1:1 fallback.**
   `... ELSE _amount END` — a currency with no rate returns the foreign amount
   verbatim, wearing a base-currency label. It also reads `exchange_rates`
   directly, applies no `override > manual > provider` precedence, and ignores
   org-scoped rows (`business_id = _business_id` only). Callers **[VF]**:
   `finance_ar_customer_credit_as_of`, `finance_ap_vendor_credit_as_of`,
   `raise_ar_dispute`, `record_promise_to_pay` — i.e. AR/AP credit exposure and
   collections commitments. Consequence **[AP]**: a foreign customer credit or
   promise is measured at 1:1, understating/overstating exposure with no signal.
2. **`to_base_amount` is SECURITY DEFINER, has no `user_can_access_business`
   check, and is granted to `PUBLIC` and `anon`.** Any caller can probe another
   business's rate book and base currency. Isolation defect **[VF]**.
3. **`_wms_generate_3pl_invoice_internal` performs its own rate lookup** against
   `exchange_rates` (org-only, latest-date-only, no source precedence). It raises
   on a missing rate, so no parity hole, but it is a third engine and can pick a
   different rate than `resolve_exchange_rate` for the same pair/date **[VF]**.
4. **`describe_exchange_rate` re-implements the resolver's precedence in its own
   body**, and `fx_exposure_by_currency` / `fx_exposure_open_items` consume it
   rather than `resolve_exchange_rate`. The two orderings agree today **[VF]**,
   but they are duplicate logic and will drift **[INF]**. The prior wave's claim
   that exposure "derives every rate from `resolve_exchange_rate`" is false.
5. **Realized FX is only produced on some settlement paths [VF].**
   `resolve_fx_realized_account` is reached from `record_multi_invoice_payment`,
   `record_multi_bill_payment`, `apply_credit_to_invoice_atomic`,
   `refund_customer_atomic`, `refund_from_vendor_atomic`, `expense_reimburse_direct`.
   It is **absent** from `record_payment_atomic` (the single-invoice AR settlement
   path, also used by POS), `apply_vendor_credit_to_bill_atomic`,
   `void_payment_atomic`, `void_bill_payment_atomic`, `unapply_payment_atomic`.
   Consequence **[AP]**: settling a foreign invoice through the single-payment path
   posts no exchange gain/loss — the AR relief is forced to balance and the
   difference lands silently in whatever the engine plugs; and reversing a
   settlement that *did* book realized FX does not reverse it.
6. **No foreign-currency accounting data exists yet [VF]**: 13 journal entries, 0
   non-base, all 28 lines have `original_currency` NULL. Every FX path above is
   therefore untested against real data — findings 1/5 are code-verified, their
   runtime blast radius is **[UNV]** until fixtures exist.

Verdict on the primary question: **No.** The engine itself (rate book, resolver,
precedence, stamping, revaluation lifecycle) is sound and centralized; the
*producers and consumers* are not — two extra rate engines exist, one with a
silent parity fallback and public grants, and the most-used settlement path emits
no realized FX.

## Accounting invariants (contract every producer must satisfy)

- **[AP]** Denomination is authoritative at the **journal line**
  (`original_currency` + `original_debit/credit` + `exchange_rate`); the document
  header is the proposal, the journal header is a convenience.
- **[AP]** Rate is determined once, at the transaction date, server-side, and
  frozen on posting. Settlement uses the settlement-date rate; the difference is
  **realized** FX at settlement (full or partial, pro-rata on partial).
- **[AP]** Only monetary items (AR, AP, cash/bank, monetary accruals) revalue.
  Inventory, prepayments and fixed assets stay at historical rate.
- **[AP]** Reversal reverses the FX consequence too: voiding a settlement reverses
  its realized FX; reversing a revaluation run nets remeasurement to zero.
- **[ADR 0136]** A missing rate is an absence: raise on a posting path, render `—`
  on a reporting path. Never 1:1, never client-computed.

## Execution order (dependency-derived, one migration per function)

**Phase 8 — collapse the second engines (do first; they are silent-parity and a
leak, which outranks reporting cosmetics).**
1. Rewrite `to_base_amount` as a thin wrapper over `resolve_exchange_rate`:
   return NULL when no rate is on file (no `ELSE _amount`), add the
   `user_can_access_business` gate, `REVOKE` from `PUBLIC` and `anon`.
2. Adapt its four callers to the NULL contract — exclude and count unrated
   amounts (`unrated_count`) instead of valuing them at parity; surface the count
   in the AR/AP credit and collections surfaces (display only).
3. Point `_wms_generate_3pl_invoice_internal` at `require_exchange_rate`.
4. Reduce `describe_exchange_rate` to provenance metadata over the same row
   `resolve_exchange_rate` picks (single ordering, defined once), leaving the
   exposure functions unchanged in output.

**Phase 9 — settlement realized FX parity.**
5. Establish how `record_multi_invoice_payment` computes realized FX, then bring
   `record_payment_atomic` onto that exact mechanism (no bespoke path) — including
   partial settlement pro-rata. Same for `apply_vendor_credit_to_bill_atomic`.
6. Make `void_payment_atomic`, `void_bill_payment_atomic` and
   `unapply_payment_atomic` reverse any realized FX the settlement booked.

**Phase 10 — reporting-projection parity (the previously-logged Phase 8).**
7. The six reporting functions: resolved rate, NULL allowed, `unrated_count`
   returned and rendered as "excludes N unrated foreign documents". Empty the
   block-9 exemption array as each lands.

**Phase 11 — ratchets and isolation.**
8. Extend `fx_revaluation_lifecycle_test.sql`: no function outside
   `resolve_exchange_rate` may read `exchange_rates` (exempt: none by the end);
   no silent `ELSE _amount` currency coercion; every FX-facing SECURITY DEFINER
   function must contain `user_can_access_business` and must not be granted to
   `anon`/`PUBLIC` (`to_base_amount` is today's counter-example).
9. Behavioural fixtures for a foreign invoice → partial payment → full payment →
   void, asserting realized FX on each leg, plus a Business A / Business B
   cross-access denial on `fx_exposure_*`, `fx_revaluation_readiness`,
   `describe_exchange_rate`, `to_base_amount`.

## Scope boundaries

Only FX source → posting → settlement → revaluation → reporting. No changes to
inventory costing (non-monetary, historical rate — correct as is **[AP]**), no
new tables, no new resolver, no client-side conversion, no unrelated reports.
Migrations stay small and single-purpose (one function each) — large migrations
have destabilised this database before.

## Tests required

`supabase/tests/fx_revaluation_lifecycle_test.sql` (blocks 12-14: single-engine
sweep, no-coercion, definer/grant isolation), a new
`fx_realized_settlement_test.sql` (behavioural, self-aborting), and
`src/test/architecture/fx-single-engine.test.ts` extended to the new surfaces.

## Execution status

Phases 1-7: verified complete. Phases 8-11: not started.
