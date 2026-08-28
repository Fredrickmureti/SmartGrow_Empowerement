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
# Consolidation Traceability — Correcting the Drill-Down Model

## What I verified in the code before writing this

- **The platform standard lives in `DrillDownDialog`.** `FinancialReports.tsx` (Balance Sheet / P&L) opens a figure in a dialog that lists the GL lines behind it, each line opens `TransactionPreviewDrawer`, and the drawer offers "View full record" which routes to the exact source document (`resolveLedgerDrillTarget` picks invoice / bill / journal entry). This is the pattern you described, and it already exists.
- **Consolidation does not use it.** `ConsolidatedTrialBalance.tsx`, `ConsolidationIntercompany.tsx` and `EliminationEvidencePanel.tsx` build *route links* through `crossEntityDrill.ts` (`ledgerDrillHref`, `journalEntryDrillHref`). Clicking a consolidated figure leaves the report, switches the active company, and drops the user on the General Ledger page to hunt for the line. `ConsolidatedStatements.tsx` has no drill at all.
- **Root cause, single and structural:** `DrillDownDialog` is hard-scoped to the *active* company — its `get_general_ledger` call passes `currentBusiness?.id`. It therefore cannot show a member company's lines while the viewer sits in the group context. The previous wave worked around that limitation by inventing link-based navigation instead of removing it. That is the wrong layer, and it is why consolidation drill-down feels like "good luck finding it".

So this wave is not "add more links". It is: teach the existing drill primitive to name a company, then move consolidation onto it and demote the route links to a secondary affordance.

## Correction to the previous wave's contract

Rule 1 of the existing contract ("every cross-entity link is built by `crossEntityDrill`") stays, but is subordinated: **route links are the deep-link/stable-reference mechanism, not the drill-down mechanism.** Drill-down is preview → drawer → full record, in place.

## Phases

### Phase 4A — Entity-aware drill primitive (foundation, no consolidation changes)
- Add an optional `businessId` + `businessName` to `DrillDownConfig`. When present, the GL query uses that company instead of the active one and the dialog header names it ("Trade Receivables · Kenya Ltd").
- Verify on the server that `get_general_ledger` refuses a `_business_id` outside the caller's access set (read the function definition and the RLS path; add a DB test if the guarantee is implicit rather than explicit). No new privileged read, no service-role path.
- Confirm `TransactionPreviewDrawer` resolves records by id under RLS and suppresses "View full record" when the viewer cannot open the source (it already has `accessNote` for this).
- Tests: entity-scoped drill contract test; a permission test that a denied company yields no rows and no link.

### Phase 4B — Consolidated Statements lineage (the case you named)
Consolidated P&L / Balance Sheet line → **preview dialog** showing the per-member contributions for that group line → expanding a member opens that member's GL lines for the mapped account (same dialog stack, entity-aware) → line opens the drawer → "View full record" lands on the exact document.
- Establish from the RPCs what each statement line maps to before wiring anything; lines that are group-owned (CTA, NCI, computed subtotals) stay non-drillable with an in-UI reason, not a dead link.

### Phase 4C — Consolidated Trial Balance and Intercompany move to the dialog
Member contribution rows and intercompany activity rows open the entity-aware dialog in place. The existing `ledgerDrillHref` becomes a secondary "Open in General Ledger" action inside the dialog (stable deep link preserved, workspace no longer destroyed).

### Phase 4D — Eliminations explainability
`EliminationEvidencePanel` keeps its evidence rows but opens both sides (declaring and counterparty entries) in the drawer stack in place, with the rule, both companies, both accounts, original and eliminated amounts, and the generated adjustment visible without leaving the page.

### Phase 5 — Cross-Company Comparative
Same treatment, plus the missing export.

### Phase 6 — Artifact integrity (PDF / Excel / CSV)
Prove artifact ↔ UI parity per surface by generating real artifacts and inspecting them, not by reading the generator. Add the traceability header (group, period, presentation currency, entities included, generation metadata).

### Phase 7 — Permissions evidence
Server-side enforcement of `finance.view_consolidated` and member scoping inside the consolidation RPCs; Playwright evidence that a viewer without Company B cannot reach B's records from a consolidated drill-down.

### Phase 8 — Wave deliverable
Per-surface lineage map, corrected assumptions, gap lists, contract update, readiness answer.

## Constraints carried forward
- No second accounting engine; all figures and evidence come from existing RPCs.
- No `ConsolidationTransactionDrawer` / `ConsolidationAccountPreview` — the Finance primitives are extended, not cloned.
- No arithmetic in the browser.
- A drill-down is offered only where records genuinely exist beneath the figure; aggregations state why they open nothing.
- Existing Finance drill behaviour must not regress (`FinancialReports` keeps passing its current tests unchanged).

## Notes
- Your Supabase project is already connected (ref `jkszmrroyjfdwokbkzis`); no connection work is needed for this wave.
- Phases 1–3 of the previous wave (scope key, entity notice, view logging) are kept — they are the deep-link half and remain correct.


================================PROGRESS STATUS==================
I had to stop mid-way through Phase 4D — the workspace ran out of credits, so the changes are in a partially applied state.

What landed:
- `DrillDownDialog` now offers "Open in General Ledger" as a secondary deep link (entity-aware, via `crossEntityDrill`).
- `ConsolidationIntercompany` activity rows now drill in place via the entity-scoped dialog instead of navigating away.
- `EliminationEvidencePanel` evidence rows were rewritten to open in place (entry → preview, account → entity-scoped drill).

What remains (do this first next session, before anything else):
1. `EliminationEvidencePanel.tsx` — `LegEvidence` still needs the `preview`/`drillConfig` state, the `DrillDownDialog` + `TransactionPreviewDrawer` renders, and the `declaring_business_name` field must be confirmed to exist on the evidence row type. It will not typecheck as it stands.
2. Update `src/test/architecture/consolidation-cross-entity-drill.test.ts` to the corrected contract: drill-down is the in-place dialog; the route builders are the secondary deep-link path now centralized in `DrillDownDialog`. The trial-balance assertion for `ledgerDrillHref` is currently red.
3. Run `npx tsgo --noEmit` and the consolidation architecture tests.
4. Recreate `.lovable/plan.md` (it does not exist) marking Phase 4A–4C complete/verified, 4D in progress with the above punch list, and 5–8 pending.