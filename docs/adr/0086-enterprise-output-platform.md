# ADR-0086 — Enterprise Output Platform: five-stage pipeline, canonical model per medium

- Status: Accepted (2026-07-20)
- Extends: ADR-0008 (multi-format document printing), ADR-0026 (cross-app
  print router), ADR-0037 (hardware execution topology), ADR-0084 (Line[]
  AST canonical for thermal), ADR-0085 (rendering ownership)

## Context

ADRs 0084 and 0085 fixed the POS ESC/POS drift by naming a single
canonical thermal AST and locking down which module may emit which
bytes. They did not codify the equivalent rule for the other three
output media (A4 documents, labels, tabular reports), and the ban on
raw `pdf-lib` / `xlsx` write APIs was scoped to `src/**` only — new
edge functions can still import `pdf-lib` and build a parallel A4
layout engine without tripping any guard.

This ADR generalises 0084/0085 into one architectural rule that covers
every printable business event the platform emits.

## Decision

Every printable output flows through exactly five stages, and each
stage has one owner per medium family:

```text
Business Event
   → Canonical Document Model    (server, one per business domain)
   → Canonical Layout Engine     (one per medium family)
   → Output Renderer             (translates layout → bytes for a medium)
   → Hardware Driver             (transport only; no layout, no business rules)
   → Physical Output
```

Medium families and their canonical owners:

| Medium family     | Canonical layout engine                                        | Renderers                                          |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Thermal / receipt | `supabase/functions/_shared/receipt/lines.ts` → `Line[]` AST   | `renderThermalPdf`, `renderDocumentEscPos`, `MonospacePreview` |
| Paged / A4        | `supabase/functions/_shared/pdf/**` (PdfBuilder + components)  | `generateDocumentPdf`, `generateStatementPdf`, `generateReportPdf`, `generateHrLetterPdf`, `generate-audit-certificate` |
| Label             | `label_templates` table + `printing/zpl/builder` (server)      | Driver-side ZPL / EPL / ESC-POS-label emitters     |
| Tabular / report  | `_shared/reports/renderReport` (row set + column specs)        | `reportPdfGenerator`, `reportXlsx`, `reportCsv`, `statementCsv` |

Invariants:

1. **One canonical model per business domain.** A receipt has one model
   (`DocumentData` projected through `documentToInput`); an A4 document
   has one (`DocumentData`); a payroll document has one
   (`ReportPdfPayload`); a label has one (`label_templates` row + `vars`);
   a tabular report has one (row set + column specs).
2. **One layout engine per medium family.** Renderers translate; they
   do not compute business layout.
3. **Preview, PDF, and device bytes for the same business event are
   derived from the same layout output** (ADR-0084 extended).
4. **Printer profiles configure media capabilities only.** They select
   paper geometry, encoding, cut behaviour — never a different layout
   pipeline.
5. **Drivers are transports.** They take a fully-rendered payload
   (`Line[]`, PDF bytes, ZPL string) and put it on a wire. They must
   not read business data, compute totals, or synthesise layout.

## Consequences

**Positive**

- Adding a new business document is one edit per stage: fetcher →
  canonical model → existing layout engine → existing renderer → existing
  driver. No new pipeline.
- Every High-severity POS-class drift becomes structurally impossible:
  the guardrails below prevent a second layout engine from being
  introduced, in `src/**` or in `supabase/functions/**`.
- Every printer (thermal, laser, label) sees documents composed by the
  same layout engine for its medium family; there is no "PDF says X, the
  printer prints Y" class of bug.

**Negative / accepted costs**

- Bespoke layouts (a signed audit certificate, a country-specific
  statutory return) must be expressed as either (a) a new layout engine
  for a new medium family with its own ADR, or (b) a documented
  layout-engine consumer inside an existing family. Ad-hoc `new
  PDFDocument()` in an edge function is out.

## Guardrails

Enforced today (retained):
- `no-raw-pdf-lib-in-app`, `no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`,
  `no-direct-barcode-lib`, `no-raw-xlsx-in-app`, `no-printservice-shim`,
  `no-direct-window-print`, `no-document-print-shadow-path`,
  `no-direct-pdf-iframe`.
- Runtime tests: `receipt-line-ast-contract`, `receipt-engine-mirror-parity`,
  `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`,
  `pos-renderer-ownership`, `adr-0085-rendering-ownership`, `parity_gate_test`,
  `escpos-parity_test`, `thermal-routing-architecture_test`,
  `csv-export-registered_test`, `hr-letters-registered_test`,
  `render_refusal_test`.

To add (tracked in the audit ledger, one build-mode plan each):
- `no-raw-pdf-lib-in-edge-functions` — mirror of `no-raw-pdf-lib-in-app`
  scoped to `supabase/functions/**` with an exemption path for
  `_shared/pdf/**`. Closes the "new edge function assembles its own PDF"
  gap.
- `label-templates-only` — forbid new callers of `buildLabelZpl` (the
  legacy stub emitter in `_shared/printing/zpl/builder.ts`), require all
  new label paths to go through `printLabelByTemplate` +
  `label_templates`, and add a runtime architecture test asserting the
  hardcoded `inventory_label` / `shipping_label` bodies have been
  migrated to `label_templates` rows.
- `statement-renders-through-document-print` — client-side statement
  print must round-trip through `useDocumentPrint`, not through raw
  `supabase.functions.invoke("generate-document")` inline in a page.

## Non-goals

- Merging the four medium-family models into one super-model. Each
  medium family (thermal, paged, label, tabular) has different
  constraints; sharing a superset serialises to a leaky abstraction. The
  invariant is one canonical model **per medium family**, not one across
  the whole platform.
- Rewriting statutory / country-specific certificate renderers. Those
  already flow through `certificate-engine` + `renderTemplateBody` +
  `generateReportPdf`; they satisfy the five-stage rule.

## Runtime-verification rule

Before any remediation change under this ADR is closed, the change must
be observed at runtime: response header (`X-Print-Policy-Renderer`,
`X-Renderer`), an edge-function log line, a byte diff against a golden
fixture, or a Playwright screenshot of the preview. Editing a renderer
and typechecking is not sufficient evidence — the POS ESC/POS incident
is the template for this rule.
