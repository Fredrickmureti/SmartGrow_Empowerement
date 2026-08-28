# Consolidation Traceability, Drill-Down & Report Artifact Integrity — Wave Status

Authoritative status file. Update after every implementation step.

## Currently active phase

Phase 4 — Consolidated Statements lineage (NOT started).

## Traceability contract (established, binding on all future consolidation bricks)

1. Every cross-entity link is built by `src/lib/reports/crossEntityDrill.ts`. No page hand-rolls a report URL.
2. The company travels in the canonical reporting scope key `business` (`REPORT_SCOPE_KEYS`), alongside `contact` (account) and `from`/`to` (period). No new URL convention.
3. The destination honours the named company (`useEntityScopeFromUrl`) and announces the switch (`EntityScopeNotice`); a company outside the viewer's access set is refused with a plain message, never silently substituted.
4. Drill only at the level that owns records. A group figure is an aggregation and opens nothing; the member contribution is the first level that maps to real books.
5. A link is rendered only where the viewer may open that company's books — server-supplied per row where the RPC says so (`viewer_can_open_ledger`), otherwise `useMemberLedgerAccess` (from `user_business_access`). This is a rail; RLS on the server remains the boundary.
6. No accounting arithmetic in the browser. Figures and evidence come from the server RPCs.
7. Consolidated rows carry provenance in `ReportRowMeta` (`accountId` + `businessId`), so an exported/archived artifact records whose books a figure came from.
8. Opening a consolidated report is audit evidence: every consolidation page logs a `report_views` row.

## Completed and verified

### Phase 1 — Shared plumbing (DONE)
- `business` added to `REPORT_SCOPE_KEYS`.
- `src/lib/reports/crossEntityDrill.ts` — `ledgerDrillHref`, `journalEntryDrillHref`.
- `src/hooks/reports/useEntityScopeFromUrl.ts` — destination honours the company; `denied` when out of access set.
- `src/components/reports/EntityScopeNotice.tsx` — announces the context switch / refusal.
- `src/pages/reports/GeneralLedger.tsx` — renders the notice, honours `business`.
- `ReportRowMeta.businessId` added.
- `src/hooks/finance/useMemberLedgerAccess.ts` — client rail for link rendering.

**Defect fixed:** elimination drill-downs linked to the General Ledger with account + period but no company, while `useGeneralLedger` scopes strictly to the active company — the drill opened the wrong company's books or an empty report.

### Phase 2 — Eliminations (DONE)
- `EliminationEvidencePanel` now uses the shared builders with `declaring_business_id` for both the journal-entry and ledger links; existing `viewer_can_open_ledger` guards preserved.

### Phase 3 — Intercompany + Consolidated Trial Balance (DONE)
- Intercompany activity rows drill to the posting company's ledger (account + period + company), gated by `useMemberLedgerAccess`, with a plain note where rows are not openable.
- Intercompany *balances* rows deliberately not drillable: a paired position spans two companies and has no single ledger — the activity table is the drill level.
- Consolidated TB: member contribution rows drill to that member's ledger. Group rows and the translation-reserve residual are intentionally not drillable (aggregation / group-owned).
- Audit logging: `useReportViewLogger()` wired into ConsolidatedStatements, ConsolidatedTrialBalance, ConsolidationEliminations, ConsolidationIntercompany (these use `ReportsLayout`, so they log explicitly). This also cleared 4 pre-existing `report-layout-coverage` failures.

**Verification:** `tsgo --noEmit` clean; build OK; `consolidation-cross-entity-drill` (8), `consolidation-eliminations` (17), `consolidated-trial-balance` (13), `consolidation-intercompany` (26), `consolidated-statements` (9), `report-layout-coverage` (37) all passing.

## Pending

### Phase 4 — Consolidated Statements lineage (NEXT)
- Establish what each statement line represents (group account over mapped member accounts).
- Statement line → member contribution (per-entity breakdown) → member ledger, using the contract above. Existing statement → eliminations link stays.
- Decide, with evidence, which lines are intentionally non-drillable (CTA, NCI, retained earnings, computed subtotals).

### Phase 5 — Cross-Company Comparative
- Verify each figure's authority and business; add drill to the contributing company's ledger; add the missing export.

### Phase 6 — Artifact integrity (PDF/Excel/CSV)
- Prove artifact ↔ UI parity per surface (same row model / same server engine).
- Artifact-level traceability header: group, period, presentation currency, entities included, report type, generation metadata.
- Decide Excel hyperlink policy against platform conventions.

### Phase 7 — Permissions / isolation evidence
- Verify server-side enforcement of `finance.view_consolidated` and member scoping inside the consolidation RPCs (currently the client checks the *active* company only).
- Playwright evidence: a viewer without access to Company B cannot reach B's records from a consolidated drill-down.

### Phase 8 — Final wave deliverable
Verified state, corrected assumptions, per-surface lineage map, gap lists (drill/deep-link/artifact/security), changes, tests, contract, readiness answer.

## Known pre-existing failures (out of scope, do not attribute to this wave)
- `report-statement-snapshot.test.ts` (balance sheet / classification snapshots).
- `financial-reports-scope-labeling.test.ts` (branch scope wiring).
- `payroll-reports-*.test.ts`, `wms-rpc-grants.test.ts`, and other unrelated suites.

## Instructions for the next agent

1. **Verify before continuing.** Re-read the Phase 1–3 files listed above and confirm: no browser-side accounting arithmetic; every consolidation link goes through `crossEntityDrill`; every link is access-gated; the General Ledger honours `business` and announces it. Run `bunx vitest run src/test/architecture/consolidation-cross-entity-drill.test.ts` plus the four consolidation suites, and `npx tsgo --noEmit`.
2. **Then resume at Phase 4 (Consolidated Statements lineage).** Do not start Phase 5+ or any remaining consolidation roadmap brick (mapping, FX, CTA, elimination engines, NCI, consolidation runs) until Phase 4 is coherent and tested.
3. Extend `consolidation-cross-entity-drill.test.ts` with each phase rather than creating parallel test files.
4. Keep the rule that a drill-down is offered only where records genuinely exist beneath the figure; document non-drillable lines in code comments and here, instead of fabricating targets.
