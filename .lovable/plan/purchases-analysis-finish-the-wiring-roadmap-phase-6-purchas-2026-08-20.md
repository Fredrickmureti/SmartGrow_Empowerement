# Purchases Analysis — finish the wiring (roadmap Phase 6: purchases & payables parity)

## Verification of the handover (this session)

VERIFIED FACT — the purchase analysis engine work exists:
- `src/services/finance/purchaseAnalysis.ts` (client seam, single caller of the RPCs, dimensions supplier / product / category / account / branch / month, unpaged export path, GL reconciliation seam).
- `src/hooks/usePurchaseAnalysis.ts`, `src/pages/reports/PurchaseReports.tsx` (passes `reportKind="purchases"`).
- `supabase/tests/purchase_analysis_engine_test.sql` — proves one definition each, SECURITY DEFINER, pinned `search_path`, `finance_can_read_org` gate, no anon EXECUTE, STABLE, base-currency normalisation, vendor credit notes subtracted, no branch-widening `IS NULL` escape.

VERIFIED FACT — all five items the previous engineer listed as pending are genuinely still pending:
- `src/lib/reports/branchScopability.ts` has no `"purchases"` kind (the page already passes it → typecheck failure).
- `src/apps/finance/routes.tsx` registers `reports/sales` but no `reports/purchases` → the page is unreachable.
- `REPORT_REGISTRY` has no `purchase-reports` entry and no relation pairs for it.
- `src/apps/purchases/nav.ts` has no Purchases-insights link to it.
- Neither isolation guard (`supabase/tests/reporting_isolation_matrix_test.sql`, `src/test/architecture/reporting-isolation-matrix.test.ts`) lists `finance_purchase_analysis` / `finance_purchase_expense_reconciliation`.

No new defects found in the delivered engine; nothing to unwind.

## Work in this phase

1. **Branch scopability** — add `"purchases"` to `ReportKind` and `BRANCH_SCOPABLE` as branch-sliceable (`true`), matching `sales`. Purchases is a flow through the GL, so the branch toggle is meaningful.
2. **Route** — register `reports/purchases` in `src/apps/finance/routes.tsx` with the same lazy pattern as `reports/sales`, immediately next to it.
3. **Registry & navigation** — add a `purchase-reports` definition (category `payables`, path `/finance/reports/purchases`, `drillDown: "dialog"`, `permission: "viewReports"`, keywords supplier/purchases/spend), plus relation pairs `["aged-payables","purchase-reports"]` and `["purchase-reports","sales-reports"]`. Add a "Purchases" link under the Purchases app Insights group. The registry is the single source for the reports nav, so no second list is introduced.
4. **Isolation guards** — extend both matrices with `finance_purchase_analysis` (domain `purchases`) and `finance_purchase_expense_reconciliation`, including the cross-organization `42501` call in the SQL guard.
5. **Verify** — `bunx vitest run src/test/architecture` and a typecheck; read the full output.
6. **Status document** — rewrite `.lovable/plan.md` afterwards recording this phase as complete, and carry over the one still-open item: the signed-in smoke test of the sales/purchase engines against live data (the read-only query role is denied EXECUTE by design, so it must be run from an authenticated session).

## Out of scope here

No SQL migration is needed — both functions are already applied and hardened. No changes to the sales, aged receivables, aged payables or partner ledger reports. No new reporting engine, no client-side accounting arithmetic.
