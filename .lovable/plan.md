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
