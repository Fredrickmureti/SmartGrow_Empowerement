# Cycle Count — documents, identifier, on-screen review and printing rebuild

## What is actually broken (verified against the live database and source tree)

1. **Printing fails for every cycle-count document.** `CountDocumentsMenu` calls `printDocument({ documentType: "count_sheet" … })`, which resolves through `resolveSourceDocumentRecord.ts`. That registry has no cycle-count rows, so the call raises `unsupported_document_type` and the operator sees "…could not be printed".
2. **The old fetchers live in a retired engine.** `fetchCountSheet`, `fetchCountSheetBlind`, `fetchCountVarianceReport` and `fetchCountAuditReport` exist only inside the legacy `generate-document` function, which the canonical pipeline no longer calls. Their template mapping points at `"invoice"` — that is where the invoice look comes from.
3. **No document kinds exist for counts.** `document_kinds` holds `wms.return_receipt`, `wms.rma_authorization`, `wms.inspection_report`, `wms.damage_report` — nothing for counts. Warehouse kinds also have no template AST rows, so they fall through to the commercial (invoice) renderer.
4. **The identifier is a clock string.** `create_count_session_as` sets `code := 'CC-' || to_char(clock_timestamp(),'YYMMDD-HH24MISSMS')`, giving `CC-260817-013059278`. Every other document uses a sequential per-organisation generator (`get_next_grn_number`, `_next_physical_count_number` → `PC-000001`).
5. **Print, preview and download are one action.** The menu only prints. `downloadDocumentRecord` and the document preview provider already exist and are unused here.

## The rebuild

### A. Business identifier
- New `get_next_count_session_number(org, business)` returning `CC-YYYY-NNNN`, parsing only the trailing counter segment and taking a per-org advisory lock (the platform's numbering rule).
- `create_count_session_as` calls it instead of the clock string. Existing sessions keep their historical codes — numbers are never rewritten.
- The linked Inventory count (`PC-…`) is shown next to the count number so the two documents are traceable to each other.

### B. Document kinds and a dedicated warehouse layout
- Migration adds four `document_kinds`: `wms.count_sheet`, `wms.count_sheet_blind`, `wms.count_variance_report`, `wms.count_audit_report`, each with a system template AST declaring `layout: "count_sheet"` / `"count_report"` and worksheet table presets — no party block, no totals ladder, no tax columns.
- New `supabase/functions/_shared/pdf/layouts/warehouseCount.ts` drawing bin / product / lot / expected / counted / difference / reason columns, a signature strip for counter and supervisor, and a blank count column on the sheets. Registered in a `WAREHOUSE_LAYOUTS` map in the PDF renderer next to `PROCUREMENT_LAYOUTS`, so the fail-closed guard can never route a count sheet to the invoice renderer.

### C. Snapshot builders (the data)
- New `src/services/documents/snapshots/wmsCount.ts`, modelled on `wmsReturn.ts`, reading the session header plus `get_count_lines` (the only sanctioned read path, which already masks blind quantities).
- The blind sheet keeps its **own** builder that never selects `system_qty` / `variance_qty` / `counted_qty` — structurally incapable of leaking an expectation.
- Difference report: latest-round lines with a non-zero difference, reason code, tolerance outcome, approver. Audit report: every attempt, every recount round, who counted, when, and the posting outcome.
- Quantities only. No money anywhere on warehouse paper.

### D. Wiring through the one engine
- Register the four types in `resolveSourceDocumentRecord.ts` (kind code, `sourceModule: "wms"`, source doc type, `partyKind: null`).
- New `dispatchCountDocument.ts` mirroring `dispatchReturnDocument`: snapshot → `ensureDocumentRecord` → `printDocumentIntent`.
- `CountDocumentsMenu` becomes a documents menu with three distinct verbs per document — **Preview** (in-app preview dialog), **Print** (policy-routed dispatch), **Download** (`downloadDocumentRecord`) — with honest failure messages that name the real cause (no printer bound vs render failure).

### E. On-screen before paper
- The count review screen gains a header identity block (count number, warehouse, strategy, blind flag, state, counter, linked `PC-` document) and a summary strip: lines counted / uncounted, differences, within tolerance, awaiting approval, open recounts.
- Each difference row explains *why* approval is required in plain English (over tolerance, high value, recount disagreement) instead of a raw outcome token, and shows the operational history inline.
- No raw UUIDs on screen: bins by code, products by name/SKU.

### F. Guards
- Replace the stale `cycle-count-documents-wiring.test.ts` (it asserts against the retired `generate-document` fetchers) with one that asserts registry rows, the dedicated layout registration, absence of any invoice mapping, the blind builder's forbidden columns, and preview/print/download separation.
- pgTAP: numbering format and uniqueness, blind masking, reason-code gate.
- Update `docs/printing-event-coverage.md` and ADR 0106 in the same change.

## Not changed
Counting, tolerance, recount, approval and posting logic. Stock keeps moving only through Inventory's approval → adjustment → journal-entry path.

## Technical notes
Order of work: migration (numbering + kinds + template AST) → snapshot builders → PDF layout + renderer registration → registry + dispatch → UI → tests/docs.