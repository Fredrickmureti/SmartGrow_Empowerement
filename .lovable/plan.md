# Finish the canonical document workspace: Vendor Statement

## Verification result (done before this plan)

I re-ran the architecture ratchet (`src/test/architecture/document-workspace-canonical.test.ts`) and read the surfaces it guards. The previous engineer's closing claim checks out:

- 9 of 10 guards pass: one status vocabulary, one line-items renderer, no hard width floors, both grids on the shared measurement engine, no `@ts-nocheck` in Sales/Purchases, forms on the editable grid.
- Exactly one failure, and it is the file named in the handover: `src/features/purchases/statements/VendorStatementRecordPage.tsx` still composes `RecordShell` directly instead of `RecordScaffold`.

So the layer is real; one surface is off-protocol.

## What is actually wrong with Vendor Statement

It is not only the shell. The vendor-statement pair is the last place where the two projections duplicate business presentation:

- The record page hand-builds header, status badge, totals ladder and a **synthesised** activity list (generated / sent), rather than declaring a descriptor and letting the audit-backed feed load.
- The peek sheet independently hand-builds its own title, status badge and period line from the same row — so the two can drift, which is precisely the drift the audit set out to kill.
- Status is decided inline (`sent_at ? "Sent" : "Draft"`) in both files instead of going through the shared `vendor_statement` status vocabulary.
- Both files repeat the dispatch handler and the `SendDocumentDialog` wiring.

## Two broken files the handover did not mention

Typecheck is **not** clean — the previous engineer's Purchases pass left two compile errors:

- `ExpensePeekSheet.tsx:23` compares an expense status against `"voided"`, which is not in the status union. The void guard is dead code as written; it should test the field that actually records a void (or the union must include it).
- `VendorPriceListPeekSheet.tsx:60` renders `ContactPreviewDrawer` without the required `open` prop, passing openness through `contactId` instead. It needs `open={vendorOpen}`.

Both get fixed first, since the ratchet run is only meaningful on a compiling tree.

## The work

1. **Add `vendorStatementView.tsx`** next to the existing pair, mirroring `billView.tsx`: a `useVendorStatementView(id, formatCurrency)` hook returning `{ statement, loading, error, view }` where `view` is a `DocumentRecordView` with
   - `kind: "vendor_statement"`, eyebrow, `listPath`, title = vendor name, `docNumber` = statement date, `status` routed through the shared registry;
   - `meta` = statement period;
   - `totalsRows` = opening balance / billed in period / payments / closing balance (emphasised), with the currency footer;
   - `documentId` set so the audit-backed activity feed replaces the hand-built entries, plus `activityExtra` for the non-audited "sent to vendor" milestone;
   - `extraSections` = the existing `VendorStatementPreview` (unchanged renderer, so peek / full page / PDF stay identical) and `DocumentVersionsSection`.
2. **Rewrite `VendorStatementRecordPage.tsx`** to `RecordScaffold {...view}` + `headerActions` only (Back / Download PDF / Send). Routing and actions stay in the page; all content comes from the descriptor.
3. **Rewrite `VendorStatementPeekSheet.tsx`** to `PeekScaffold` fed by the same descriptor, matching how the Bill peek consumes `useBillView`.
4. **Share the dispatch + send wiring** so `dispatchVendorStatement` and `SendDocumentDialog` props are built once, not once per surface.
5. **Delete nothing else**; no legacy fallback stays behind.

## Verification

- `document-workspace-canonical.test.ts` → 10/10.
- Typecheck clean.
- Browser check of `/purchases/statements` (peek) and `/purchases/statements/:id` (full page): same header facts, same status, same totals, no horizontal scroll in the drawer.

## Notes

No new dependencies. No database changes. The `vendor_statement` kind already exists in `documentStatus.tsx`, so no vocabulary extension is needed unless the registry lacks the draft/sent pair, in which case it is added there rather than in the feature.
