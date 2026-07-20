
# Enterprise Output Platform Audit

## Objective

Determine whether any business document besides the POS ESC/POS receipt (already remediated under ADR-0084 / ADR-0085) suffers from the same architectural drift: layout logic living inside a renderer instead of a canonical layout engine, or multiple runtime paths producing "the same" document differently. Deliver an audit + ADR + prioritized remediation plan, executed one medium at a time.

## First principles (target architecture)

Every printable output must flow through five clearly-owned stages, mirroring SAP Smart Forms / Oracle BI Publisher / Odoo QWeb+report / Dynamics FR:

```text
Business Event
   → Canonical Document Model   (server, one per domain)
   → Canonical Layout Engine    (medium-family: thermal | paged | label | report)
   → Output Renderer            (PDF | ESC/POS | ZPL | CSV/XLSX | HTML preview)
   → Hardware Driver            (transport only)
   → Physical Output
```

Rules the audit will enforce:
- One canonical model per business domain (receipt, ERP document, statement, payroll doc, label, tabular report).
- One layout engine per medium family; renderers translate, they do not compute.
- Preview, PDF, and device-native bytes for the same event must derive from the same layout output.
- Printer profiles configure media capabilities only; they never fork layout code.
- Drivers are transports (bytes in → wire out); no business rules, no layout.

## Scope — every printable business event

Grouped by the medium family they should belong to. The audit produces an entry per row.

**Thermal / receipt-class** (canonical: `receipt/lines.ts` → `Line[]`)
- POS sale receipt, POS refund/reprint, POS payment slip, kitchen ticket, customer display draft.

**Paged / A4-class** (canonical: `_shared/pdf` + `templateRenderer` `DocumentData`)
- Sales invoice, quotation, estimate, credit note, debit note, proforma.
- Purchase order, purchase receipt / GRN, vendor bill, RFQ.
- Delivery note, picking list, packing slip, transfer document, GDN, stock adjustment sheet, inventory count sheet.
- Payment receipt (A4), remittance advice, customer statement, vendor statement, aging report.
- Payslip, employment/HR letters, tax certificate (P9/P10/etc.), statutory returns, audit certificate.

**Label-class** (canonical: `label_templates` + `printing/zpl/builder` / EPL driver)
- Product / shelf / price labels, barcode labels, GS1 labels, pallet / carton labels, warehouse location labels, shipping labels.

**Tabular / report-class** (canonical: `_shared/reports` + `_shared/exports`)
- CSV / XLSX exports, scheduled reports, `render-report` outputs, statement CSV.

## Method (per row)

For each business event, complete a table row with runtime-verified evidence — no path is trusted just because it exists.

1. **Trigger** — UI/API/cron site (file:line).
2. **Server entrypoint** — edge function or server fn actually invoked (`generate-document`, `generate-payslip-pdf`, `render-report`, `printClient.print`, `printLabelByTemplate`, …).
3. **Canonical model** — the typed input the server builds (`DocumentData`, `ReceiptLinesInput`, `PayrollDocumentData`, `LabelVars`, report row set).
4. **Layout engine** — module that turns the model into a medium-neutral layout (or "MISSING" if the renderer computes layout inline).
5. **Renderer(s)** — every module that emits final bytes for that model (PDF, ESC/POS, ZPL, XLSX, HTML preview). List all, not just the "intended" one.
6. **Driver / transport** — how bytes reach the device (`printClient`, agent, CUPS, Win spooler, browser download).
7. **Runtime proof** — one of: added `X-Renderer` header + curl trace, `console.log` from a live invocation, or a Playwright run against the preview that captures the request. Not "the code looks like it does X".
8. **Drift flags** — duplicate model, duplicate layout, preview≠PDF, PDF≠device bytes, driver contains layout, business rules inside renderer, missing printer-profile awareness, missing artifact capture in `document_artifacts`.

Mechanical helpers used during the audit (read-only in this pass):
- ripgrep sweeps for every `supabase.functions.invoke("generate-*"|"render-report")`, every `printClient.print(`, every `printLabelByTemplate(`, every `new PDFDocument`, every `XLSX.write*`, every `^XA`, every ad-hoc `\x1B` / `\x1D` byte string.
- Cross-reference against existing guardrails (`no-raw-pdf-lib-in-app`, `no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`, `no-direct-barcode-lib`, `no-raw-xlsx-in-app`, `no-printservice-shim`, `no-direct-window-print`, `no-document-print-shadow-path`) to find domains lacking equivalent guards.
- Runtime tracing via `stack_modern--invoke-server-function` + `stack_modern--server-function-logs` and Playwright against the preview to prove which path is actually reached.

## Deliverables

1. **`docs/audit/2026-07-20-enterprise-output-platform.md`** — the full runtime-verified matrix (one row per business event) with drift flags and evidence links.
2. **`docs/adr/0086-enterprise-output-platform.md`** — codifies the five-stage pipeline, names the canonical model + layout engine per medium family, and states the invariant "preview, PDF, and device bytes are the same layout".
3. **Drift ledger** appended to the audit doc, prioritized High / Medium / Low by: (a) customer-visible divergence risk, (b) statutory/fiscal exposure, (c) number of duplicate paths.
4. **Per-drift remediation stubs** — one short follow-up plan section per High/Medium item, each scoped to a single medium family, each with: canonical owner, files to delete/merge, guard rule to add, runtime proof required to close.

Explicitly out of scope of this plan: writing any of the remediation code. Each High/Medium drift becomes its own build-mode plan, executed one at a time, mirroring the POS ESC/POS consolidation pattern (identify canonical owner → migrate callers → add ESLint + runtime guard → prove old path is dead → delete).

## Runtime-verification rule (non-negotiable)

For every remediation that follows this audit: before claiming a path is fixed, trigger the business event against the running preview and confirm the change is observable (response header, log line, byte diff, or Playwright screenshot). If the observed output does not change, stop and locate the active path before editing further — the POS ESC/POS incident is the template for this rule.

## Technical section (for engineers)

Already-canonical paths confirmed by inspection (audit will re-verify at runtime):
- Thermal receipt: `receipt/lines.ts` → `renderThermalPdf` and `renderDocumentEscPos`, gated in `generate-document/index.ts` by `routeThroughThermalEngine`, guarded by `receipt-line-ast-contract`, `receipt-engine-mirror-parity`, `pos-receipt-model-boundary`, `parity_gate_test`, `escpos-parity_test`.
- A4 documents: `generate-document` → `_shared/pdfGenerator.generateDocumentPdf` / `generateStatementPdf`; A4 canonical model = `DocumentData` from `_shared/templateRenderer.ts`. Self-defends against `pos_receipt` (asserted by `thermal-routing-architecture_test`). Audit must verify there is exactly ONE layout engine for A4 across invoices/POs/GRNs/delivery notes/statements.
- Labels: `label_templates` table + `printing/zpl/builder` (server) + `ZplLabelDriver` / `EplLabelDriver` (transport). Audit must confirm no page/screen renders label PDFs or barcode rasters client-side and that `printLabelByTemplate` is the only entry.
- Reports: `render-report` + `_shared/exports/reportXlsx` / `reportCsv`. Audit must confirm no client-side XLSX generation and CSV parity with PDF.
- Payroll / HR letters / tax certificates: `generate-payslip-pdf`, `generate-payroll-document`, `generate-tax-certificate`, `_shared/hrLetterGenerator`. Audit must confirm they share the A4 layout engine rather than each embedding page geometry.

Candidate drift hotspots to prove or disprove first (highest suspicion, based on file inventory):
- Multiple payroll/HR/tax PDF entrypoints (`generate-payslip-pdf`, `generate-payroll-document`, `generate-tax-certificate`, `generate-audit-certificate`, `hrLetterGenerator`, `reportPdfGenerator`) — verify they all delegate to `_shared/pdf` primitives or flag layout duplication.
- Statement rendering (`generateStatementPdf` vs `statementCsv` vs `CustomerStatements.tsx` / `VendorStatements.tsx` inline invokes) — verify PDF ↔ CSV parity from a single row model.
- Client-side print helpers (`hooks/useDocumentPrint.ts`, `usePrintOrPreview.ts`, `PrintPreviewDialog`, `PrintSettingsPopover`) — verify none synthesize `DocumentData` in the browser; all must round-trip through `generate-document`.
- Label ecosystem — confirm every label class (shelf, GS1, pallet, carton, shipping) has a `label_templates` row and a driver renderer; flag any label produced by an ad-hoc code path.
- `_shared/pdfGenerator.ts` (single file) vs `_shared/pdf/**` (module) — confirm the monolith is a shim over the modular engine, not a parallel implementation.
- Cross-check every existing ESLint rule under `eslint-rules/` for medium families with NO guard; the audit ledger proposes the missing guard as part of remediation.

