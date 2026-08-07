# Preview vs Print: verdicts and a canonical document viewing architecture

## What I verified in the code (not assumptions)

1. **Receipts list: "View Receipt" really does print.**
   `src/pages/CustomerPayments.tsx:651-653` wires `onViewReceipt`, `onDownloadReceipt` and `onPrintReceipt` to the *same* `handleDispatchReceipt`, which builds a snapshot, creates a document record and calls `acknowledgeRecordPrint(...)` — a real dispatch into the print pipeline. The comment above it says the collapse was intentional ("all three legacy legs collapse into one intent submission"). So viewing spools paper and writes a print-ledger row.

2. **Invoice → "View Receipt" preview is stuck on thermal.**
   `src/pages/Invoices.tsx:629` opens `PrintPreviewDialog` correctly, but the server renderer has two defects:
   - `supabase/functions/_shared/rendering/renderers/pdf.ts:63` forces the thermal Line[] / `renderThermalPdf` path whenever `document_type` is `receipt` or `pos_receipt`, **regardless of requested paper**. Choosing A4 cannot escape it.
   - The override never even arrives: the client sends `options.paper_format` (`PrintService.renderSourcePair`), but `pdf.ts:59` reads `opts["paperFormat"]` (camelCase). The key never matches, so an explicit A4 request is silently dropped.
   The A4 selector is therefore inert for receipts. This is not "deeply entrenched output policy" — it is a hard-coded document-type gate plus a key-name mismatch.

3. **The invoice itself has no preview.**
   The row menu offers Print, Download, Email, View Receipt — no Preview (`src/components/invoices/InvoiceListTable.tsx:162`). `RecordScaffold` exposes only `onPrint` (`src/design-system/records/RecordScaffold.tsx:43,140`), and `useRecordPrint` has no preview counterpart. The preview dialog exists and works; invoices simply cannot reach it.

## Verdicts (how mature ERPs model this)

SAP S/4HANA, Oracle Fusion, D365, NetSuite, Odoo and Acumatica all separate three verbs, and that vocabulary is worth adopting exactly:

- **Preview / View** — a render with no side effects. Never touches a device, never writes a print ledger row, and shows the document in its *native* archive geometry (A4/Letter), because the operator is reading, not producing paper. Odoo's report preview, NetSuite "View PDF", SAP Output Management "Preview" all behave this way.
- **Print** — a dispatch. Resolves output policy (paper, render mode, copies, device), spools, records an output entry. Odoo `report_action` + paperformat; SAP output condition records.
- **Download / Email** — distribution of the same archived artifact.

Two further patterns to take:
- **Policy governs printing, not reading.** Paper format belongs to output determination. A thermal policy means "when printed at this branch, print 80mm" — it must not decide what appears on screen.
- **Medium is a property of the artifact, not of a hard-coded kind list.** "receipt" is a document kind; 80mm is a medium. Choosing the renderer from the kind name is the real architectural defect.

Verdict on the current design: collapsing view/print/download into one intent is wrong for the read path. It is right for print/download (one canonical renderer, one archived artifact) and stays.

## Refactoring plan

### Phase 1 — Fix the render contract (server)
- Normalise option keys once in `resolveContext` (accept `paper_format`/`paperFormat`, `render_mode`/`renderMode`) so an override can never be dropped by casing.
- Replace the `docType === "receipt"` gate in `pdf.ts` with medium-driven selection: thermal renderer only when the resolved paper token is `40mm/58mm/80mm`. Kind no longer forces geometry; POS receipt kinds still default to thermal through `template.media_class`, which remains overridable.
- Preview requests carry an explicit `intent: "preview"` so the engine defaults to native archive geometry unless the operator overrides.

### Phase 2 — A canonical, side-effect-free preview seam (client)
- Add a render-only `previewDocument()` entry to `PrintService`: no ledger, no device, no auto-print.
- Add `useDocumentPreview(kind)` mirroring `useRecordPrint`, returning `{ preview, previewing }` and opening `PrintPreviewDialog`.
- Lock the invariant with a ratchet test: no list page or record page may bind a View/Preview affordance to a dispatch function (`acknowledgeRecordPrint`, `printDocument*`).

### Phase 3 — Restore the three verbs on every sales surface
- Payments list: `onViewReceipt` → preview dialog; `onPrintReceipt` keeps `handleDispatchReceipt`; `onDownloadReceipt` downloads the archived artifact instead of printing.
- Invoices: add **Preview** to the row menu and to the drawer / record action bar, separate from Print.
- `RecordScaffold`: add a first-class `onPreview` slot so every record page (sales and purchases) inherits the same three verbs.

### Phase 4 — Propagate and prove
- Wire preview through the remaining documents that already have print (estimates, orders, delivery notes, credit notes, proforma, statements) and the purchase equivalents via the shared scaffold.
- Preview dialog: default paper = document native, so the paper selector genuinely re-renders; show the resolved policy as information about *printing*, not about the view.
- Verify with typecheck, the existing `src/test/architecture/` printing tests, the new ratchet, and a manual pass confirming a receipt preview renders A4 when A4 is chosen and 80mm when 80mm is chosen.

## Technical notes
- No new dependencies. Changes sit in the rendering engine, `PrintService`, `RecordScaffold`, and the two list pages.
- No parallel renderer: preview and print keep calling the same `render-document` engine and the same archived-artifact path; only the side effects differ.