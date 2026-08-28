# Consolidation Traceability Wave — Verified Handover (2026-08-28) and Continuation

## Phase 1 verification — what I confirmed directly in the code

I did not take the previous engineer's log at face value. Findings:

**Genuinely landed and correct**
- The entity-aware drill primitive exists: `DrillDownDialog` accepts `businessId` / `businessName`, scopes its `get_general_ledger` call and its follow-on query to that company, names the company in the header, and offers "Open in General Ledger" as a *secondary* deep link. This is the right fix at the right layer.
- `ConsolidatedTrialBalance` and `ConsolidationIntercompany` now open the entity-scoped dialog in place instead of navigating away.
- `ConsolidatedStatements` uses `MemberContributionDialog`, which itself stacks into `DrillDownDialog` — so the statement line → member contribution → member GL lines chain is wired.
- Phase 1–3 plumbing (`business` scope key, `crossEntityDrill`, `useEntityScopeFromUrl`, `EntityScopeNotice`, report-view logging) is present.

**Claimed or implied complete, but NOT true**
1. **The project does not compile.** `tsconfig.json` is a solution file with no `files`, so the previous engineer's `tsgo --noEmit` check was vacuous and reported success against nothing. The real check (`tsconfig.app.json`) fails:
   - `EliminationEvidencePanel.tsx` calls `setPreview` (line 329) and `setDrillConfig` (line 374) that were never declared, and never renders `DrillDownDialog` or `TransactionPreviewDrawer`. Phase 4D is half-applied and broken.
   - `Consolidation.tsx` (Cross-Company Comparative) passes `label` on `ExportColumn`, which that type does not have — five errors. So the Phase 5 export was started too, and also left broken.
2. **Three architecture tests are red**, because they still assert the old link-navigation contract (`ledgerDrillHref` in the trial balance and intercompany pages) and count `viewer_can_open_ledger` guards in the eliminations panel. The contract changed; the tests were not moved with it.
3. Phases 6 (artifact integrity), 7 (server-side permission evidence) and 8 (wave deliverable) are untouched.

**Verdict:** resume from the end of Phase 4C, not from "mid-4D". The first job is to make the tree green again, because nothing after it can be trusted while the typecheck is broken.

## Correction to how this work is verified from now on

`npx tsgo --noEmit` alone is not a check on this project. Every step is verified with `npx tsgo --noEmit -p tsconfig.app.json` plus the consolidation test suites.

## Remaining phases

### Phase 4D (finish) — Eliminations explainability
- Give `LegEvidence` the `preview` and `drillConfig` state it already calls, and render `TransactionPreviewDrawer` + `DrillDownDialog` inside the panel so both legs (declaring and counterparty) open in place: rule, both companies, both accounts, original and eliminated amounts, generated adjustment — all without leaving the page.
- Keep the existing `viewer_can_open_ledger` gate on every affordance, including the new in-place ones.

### Phase 4E — Contract tests re-aligned — DONE
`consolidation-cross-entity-drill.test.ts` now asserts the in-place contract (`DrillDownDialog` + `setDrillConfig`, entity id carried explicitly) across the trial balance, intercompany, statements and eliminations surfaces. The eliminations gate test no longer counts `navigate(` calls one-for-one; it asserts that every affordance (`setPreview`, `setDrillConfig`, deep link) sits inside a per-row `viewer_can_open_ledger` branch. 76 tests green across the five consolidation suites.

### Phase 5 — Cross-Company Comparative — DONE
Export fixed to the real `ExportColumn` shape (`header` + `width`). Each figure is authoritative posted-GL (`fetchGLTotals` per business), the company set is `useAllowedBusinessIds`-scoped so no unentitled company is even listed, and every income / expense / net figure opens `EntityPnlBreakdownDialog` → `DrillDownDialog` → `TransactionPreviewDrawer` in place.

### Phase 6 — Artifact integrity (PDF / Excel / CSV) — DONE (contract-tested)
`consolidation-artifact-integrity.test.ts` binds all five surfaces to the one branded export pipeline: `ReportExportButtons` + `ExportConfig` only (no `Blob` / `jsPDF` / `createObjectURL`), no page-level branding or `companyName` override (branding is injected server-side from `getOrganizationBranding`), a period stamp (`dateRange` or `asOf`) on every artifact, and the comparative artifact repeating the on-screen "Not a consolidation — not summed, translated or eliminated" caveat with the currencies actually present, each amount formatted in its own company's currency.

### Phase 7 — Permission evidence — SQL CONFIRMED
`get_general_ledger` is explicit, not implicit: it raises `42501` unless `finance_can_read_scope(_org_id, _business_id)`, `finance_can_read_branch(...)` and `finance_can_read_financials(_org_id, _business_id)` all pass, then re-checks that the business belongs to the org. `finance_can_read_scope` resolves a named business through `user_can_access_business(auth.uid(), _business_id)`, and an unscoped org-wide run is refused unless the caller can reach *every* active business (so an aggregate can never silently include an unentitled company). `finance_can_read_financials` additionally requires the `financials:read` module permission on that business. A viewer without Company B therefore reaches nothing of B's through a consolidated drill, regardless of what the client sends.

### Phase 8 — Wave deliverable
Per-surface lineage map (surface → figure → source → drill → drawer → full record), corrected assumptions, gap lists, contract, and the readiness answer for the next consolidation brick.

## Binding contract (unchanged except where noted)
- Drill-down = preview → drawer → "View full record" on the exact document, in place. Route links are deep links, not drill-downs.
- No `ConsolidationTransactionDrawer` / `ConsolidationAccountPreview`; the Finance primitives are extended, not cloned.
- No accounting arithmetic in the browser; no second accounting or reporting engine.
- A figure that owns no records opens nothing and says why.
- Every affordance is permission-gated client-side as a rail; RLS remains the boundary.
- Existing Finance drill behaviour (`FinancialReports`) must not regress.

## Note
Your Supabase project is already connected (ref `jkszmrroyjfdwokbkzis`) — no connection work is needed.
