
## Side quest (user-directed): Purchases KPI card parity with Finance AR/AP — COMPLETE (2026-08-28)
All Purchases module stat strips now use the canonical `SummaryStatCard`/`SummaryStatGrid` from `src/components/common/SummaryStatCards.tsx` (same component, tones, accent rules and responsive auto-fit grid as Finance Receivables/Payables):
- Migrated: Bills, RFQs, Expenses, VendorPriceLists (Supplier conditions), PurchaseReports, LandedCostListPage, AgedPayables, ApReconciliation, ContractListPage (KpiRibbon → SummaryStatGrid).
- Already standard (verified, skipped): PurchasesDashboard (Overview), PurchaseOrders, PurchaseReturns, VendorStatements.
- Verified: `tsc --noEmit` clean; Vite build OK (2026-08-28T02:09:31Z).
Next agent: resume the FX roadmap at Phase 9 (realized FX on payment settlement and reversals) after verifying Phase 8 guards still pass (`supabase/tests/fx_single_rate_reader_test.sql`, `src/test/architecture/fx-single-engine.test.ts`).
