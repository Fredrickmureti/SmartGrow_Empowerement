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

### Phase 4E — Contract tests re-aligned
Rewrite `consolidation-cross-entity-drill.test.ts` and the eliminations assertions to the corrected contract: drill-down is the in-place entity-scoped dialog; `crossEntityDrill` is the secondary deep-link path, now centralized in `DrillDownDialog`. Assert the gate (no affordance without permission), not the URL builder.

### Phase 5 — Cross-Company Comparative
Fix the broken export (use the real `ExportColumn` shape), verify each figure's authority and owning company, and give the contributing-company figures the same in-place drill.

### Phase 6 — Artifact integrity (PDF / Excel / CSV)
Generate real artifacts for each consolidation surface and inspect them; prove UI number = server number = artifact number. Add the traceability header (group, period, presentation currency, entities included, generation metadata). No second reporting engine.

### Phase 7 — Permission evidence
Confirm in the SQL that `get_general_ledger` and the consolidation RPCs refuse a `_business_id` outside the caller's access set — the drill primitive now names a company, so this guarantee must be explicit, not implicit. Add a DB-level test if it is only implicit. Then browser evidence that a viewer without Company B reaches nothing of B's through a consolidated drill-down.

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
