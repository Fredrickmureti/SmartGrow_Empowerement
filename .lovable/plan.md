# Currency & FX — authoritative status (2026-08-22, Phases 13–17 complete)

Authority: ADR 0135 / 0136 / 0138. Scope boundary: FX source → settlement →
posting → FX engine → FX reporting. No second rate table, no second resolver,
no client-side conversion that posts, no unrelated module work.

## Currently active phase

None in flight. Phases 13–17 are closed. The next agent starts with the
verification pass below, then opens **Phase 18**.

## Done and verified

### Phase 11–12 (earlier waves) — verified by catalogue reads
AP aggregates guard on absence and expose `unconvertible_document_count`; no
`'USD'` literal in the AP/AR open-item projections; the client no longer falls
back to a foreign amount when the base amount is null; AP UI renders through
`BaseCurrencyAmount`.

### Phase 13 — AR absence parity (SQL) — DONE
- `finance_ar_aging_reconciliation` nulls its aging and credit totals when any
  contributing row is unconvertible and returns `unconvertible_document_count`.
- `finance_ar_customer_credit_as_of` derives the currency from the business base
  currency instead of a `'USD'` literal.
- `get_ar_ap_aging_from_ledger` ages the **base** residual and contributes the
  **base** credit amount, so a foreign credit with no rate contributes NULL, not
  its face amount at a silent 1:1.

### Phase 14 — AR client + UI parity — DONE
- `useAgingReport.ts` carries a nullable `balance_due` and an
  `unconvertibleDocumentCount` at report and contact level; no zero coercion.
- `AccountsReceivable`, `AccountsPayable`, `Collections` render document balances
  through `BaseCurrencyAmount` ("No rate on file").
- `AgingReport` shows an incomplete-total banner linking to currency settings.
- `services/finance/aging.ts` + `fetchContactOpenItemAging` carry
  `unconvertible_document_count` through the shared statement engine.
- Customer and vendor statement previews **and** the printed statement snapshots
  (`salesCustomerStatement.ts`, `purchasesVendorStatement.ts`) disclose excluded
  documents on the face of the document; `ContactAgingBreakdown` shows the same.

### Phase 15 — ratchets — DONE
- `supabase/tests/fx_open_items_absence_test.sql` clauses 5 and 6: every
  AR/AP aggregate over the open-item projections must carry the absence guard and
  an unconvertible count; the ledger aging feed must read base amounts.
- `src/test/architecture/fx-base-amount-fallback.test.ts`: no
  `base_*_amount ?? <foreign amount>` anywhere under `src/services/finance/**`.
- `src/test/architecture/fx-aging-absence.test.ts` extended to the statements,
  the shared helper and the FX settings surfaces.

### Phase 16 — `finance_open_items_tieout` — DONE
View rewritten (migration applied): the `'USD'` literal is gone, the AP side
resolves through `to_base_amount` (stamped rate first), the projection total is
NULL when any contributing document is unconvertible, and the view now exposes
`unconvertible_document_count` per side. The ratchet exemption was removed and
clause 7 now enforces this. Grants (`anon`/`authenticated`/`service_role`) verified
intact after the replace.

### Phase 17 — FX settings surface audit — DONE
`CurrencySettings.tsx` picks currencies from the catalogue (no free-typed code),
shows `source`, `provider_key`, `published_at`, and states precedence
(override > manual > provider, latest effective date wins, documents keep their
stamped rate). `FinanceAccountingControls.tsx` FX tab now renders the canonical
`ExchangeRatePanel` beside each foreign balance so a displayed rate always carries
its provenance. A ratchet locks both surfaces.

## Pending work

### Phase 18 — currency literals in the document snapshot builders  ← NEXT
`src/services/documents/snapshots/*.ts` still contain `|| "USD"` fallbacks
(`salesOrder`, `salesProforma`, `purchasesPo`, `purchasesRfq`,
`purchasesRequisition`, `purchasesReturn`, `purchasesVendorCreditNote`,
`financeJournalEntry`, `wmsReturn`, and the two statement builders). A printed
document that invents "USD" misstates the denomination. Fix as a class:
fall back to the business base currency, and when that is absent render the
document without a currency label rather than asserting one. Add a vitest
ratchet over `src/services/documents/snapshots/**` forbidding a currency literal.

### Phase 19 — exercised-data proof
Live `exchange_rates` holds base-currency rows only, so foreign paths are proven
by catalogue tests and construction. Consider a seeded scenario fixture that
exercises an unconvertible document end to end (projection → aggregate → UI).

## Carried limitations (documented, not defects)
- `payments` / `customer_credit_balances` carry no currency column: advances are
  structurally base-currency only. Schema change out of scope without a decision.
- `.sql` suites under `supabase/tests/` cannot be executed from this environment;
  their catalogue assertions were re-run as read-only SELECTs.
- Pre-existing unrelated failures: `bill-payment-allocations-first-class.test.ts`,
  `financial-reports-scope-labeling.test.ts`.
- Supabase binding is `jkszmrroyjfdwokbkzis`. Connecting `AccrualFlowCorporation`
  would be a destructive re-bind and stays out of scope.

## Scope boundaries
No changes to the resolver, the rate book, stamping, settlement or revaluation
mechanics — verified correct in earlier waves. No new views, no second
aggregation path, no client-side rate maths.

## Instructions for the next agent

1. **Verify before you build.** Re-read this file, then confirm against the live
   catalogue and the code — not against these claims:
   - `finance_ar_aging_reconciliation`, `get_ar_ap_aging_from_ledger`,
     `finance_open_items_tieout` behave as described above;
   - `unconvertible_document_count` reaches the UI on both AR and AP;
   - `bunx vitest run src/test/architecture/fx-*.test.ts
     src/test/architecture/aging-single-source.test.ts
     src/test/architecture/reports-data-source-contract.test.ts` is green;
   - `npx tsgo --noEmit -p tsconfig.app.json` is clean.
2. **Then resume at Phase 18** — the snapshot currency literals — and finish it
   to a coherent, production-ready state (fix + ratchet + typecheck) before
   opening Phase 19. Do not start unrelated modules, and do not leave a phase
   partially applied.
3. **Update this file at the end of every implementation** with what is done,
   what is pending, the active phase and the next one.
