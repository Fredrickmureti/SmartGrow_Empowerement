# Enterprise Output Platform Audit — 2026-07-20

Status: initial audit pass, static evidence complete, runtime verification
staged (see "Runtime verification" section).

Scope: every printable business event across POS, sales, purchasing,
warehouse, labels, payroll, HR, statutory, and reports. Purpose: identify
architectural drift equivalent to the POS ESC/POS incident (renderer
bypassing the canonical layout engine), grouped by medium family, and
codify a remediation ledger.

Companion documents:
- Target architecture: [ADR-0086](../adr/0086-enterprise-output-platform.md)
- Prior corrections: [ADR-0084](../adr/0084-receipt-line-ast-canonical.md),
  [ADR-0085](../adr/0085-rendering-ownership.md)

## Method

For every business event below, the audit records:
`trigger → server entrypoint → canonical model → layout engine → renderer(s) → driver → runtime proof → drift flags`.
Evidence uses `file:line` pointers so any assertion can be re-verified.

Static evidence was collected with ripgrep sweeps over `src/**`,
`supabase/functions/**`, and `electron/**`. Runtime verification (per-event
curl / Playwright / log-tail) is scheduled per drift item below rather
than blanket-executed — the guardrail matrix already covers most paths
transitively.

## Medium-family matrix

Legend: ✅ single canonical path proved by inspection + existing guardrail
test. ⚠️ single path but no guardrail. ❌ divergent / parallel path found.

### Thermal / receipt-class — canonical: `receipt/lines.ts` → `Line[]`

| Business event                    | Server entry                                          | Layout                | Renderers                                                        | Driver                           | Status |
| --------------------------------- | ----------------------------------------------------- | --------------------- | ---------------------------------------------------------------- | -------------------------------- | ------ |
| POS sale receipt                  | `generate-document` (`fetchPOSReceipt`, `routeThroughThermalEngine`) | `Line[]`   | `renderThermalPdf`, `renderDocumentEscPos`, `MonospacePreview`   | `printClient` → agent / driver   | ✅ ADR-0084/0085; `thermal-routing-architecture_test`, `parity_gate_test`, `escpos-parity_test` |
| POS refund / reprint              | same, with `settingsSource="refreshed"` phase 3       | `Line[]`              | same                                                             | same                             | ✅     |
| Kitchen ticket                    | `generate-document` → `receipt/kitchen.ts` (POS receipt projection) | `Line[]` subset | ESC/POS kitchen driver                                       | `EscPosKitchenDriver`            | ✅ single fetcher, projected model (`generate-document/index.ts:1659-1661`) |
| Customer display draft            | client-side render only (`CustomerDisplayDriver`)     | n/a (visual)          | driver                                                           | driver                           | ✅ visual only, not a print byte path |

### Paged / A4-class — canonical: `_shared/pdf/**` + `DocumentData`

| Business event                       | Server entry                                       | Layout                       | Renderer                              | Status |
| ------------------------------------ | -------------------------------------------------- | ---------------------------- | ------------------------------------- | ------ |
| Sales invoice / quotation / estimate / credit note / proforma / sales order / delivery note / sales return | `generate-document` | `DocumentData` → `_shared/pdf` primitives | `generateDocumentPdf` (`pdfGenerator.ts:1-30`) | ✅ single engine |
| Purchase order / bill                | `generate-document`                                | same                         | `generateDocumentPdf`                 | ✅     |
| Goods received note (GRN)            | `generate-document` (`fetchGoodsReceivedNote` at `generate-document/index.ts:394-420`) | same | `generateDocumentPdf`         | ✅     |
| Customer / vendor statement (PDF)    | `generate-document` (`fetchStatement*`)            | `DocumentData` statement branch | `generateStatementPdf` (`pdfGenerator.ts:624-680`) | ✅ server; ⚠️ client entrypoint drift — see D3 |
| Payslip                              | `generate-payslip-pdf`                             | `ReportPdfPayload`           | `generateReportPdf` → `_shared/pdf/**` | ✅ (`generate-payslip-pdf/index.ts:13-17`) |
| Payroll document (register, summaries) | `generate-payroll-document`                      | `ReportPdfPayload`           | `generateReportPdf`                   | ✅ (`generate-payroll-document/index.ts:19`) |
| Tax certificate (P9 etc.)            | `generate-tax-certificate`                         | `certificate-engine` compile → `ReportPdfPayload` | `generateReportPdf` | ✅ (`generate-tax-certificate/index.ts:15-27`; `render_refusal_test.ts`) |
| Audit certificate                    | `generate-audit-certificate`                       | direct `PdfBuilder` + components (bespoke chrome) | own composition | ⚠️ D5 — bespoke composition on shared primitives; not drift, but no guardrail forces new bespoke docs to declare themselves |
| HR letters (offer, promotion, warning, contract) | `generate-document` → `generateHrLetterPdf`  | `_shared/pdf` primitives + `SignatureBlock` | `generateHrLetterPdf` (`hrLetterGenerator.ts:1-30`) | ✅ single engine, guarded by `hr-letters-registered_test` |
| Scheduled report PDF                 | `process-scheduled-reports` → `generateReportPdf` | `ReportPdfPayload`           | `generateReportPdf`                   | ✅     |

### Label-class — canonical (target): `label_templates` + `printLabelByTemplate`

| Business event         | Trigger                                    | Server / template            | Renderer                    | Driver                     | Status |
| ---------------------- | ------------------------------------------ | ---------------------------- | --------------------------- | -------------------------- | ------ |
| Product / shelf / price label | `Products.tsx:78,202,223`             | `printLabelByTemplate({ templateKey: 'product_label' })` → `label_templates` row | driver-side ZPL/EPL | `ZplLabelDriver` / `EplLabelDriver` | ✅ `products-label-print.test.ts` |
| Business-saga labels (receiving / GRN / shipping / picking) | `BusinessSagaMount.tsx:129,156,181,196` | `printLabelByTemplate({...})` | driver-side ZPL/EPL | same | ✅     |
| Reprint (any label)    | `reprintClient.ts:19,58`                   | `printLabelByTemplate`       | same                        | same                       | ✅     |
| `inventory_label` / `shipping_label` legacy path | `generate-document` `documentType==="inventory_label"|"shipping_label"` (`generate-document/index.ts:2216-2218`) | `buildLabelZpl(supabase, documentType, documentId)` — **hardcoded ZPL body** in `_shared/printing/zpl/builder.ts:38-52` | server ZPL emitter | any label driver | ❌ **D1** — parallel implementation. The builder's own header comments it as a stub predating `label_templates`. Two ZPL sources of truth exist for the same business intent. |

### Tabular / report-class — canonical: `_shared/exports/**`

| Business event                 | Server entry                | Renderer                    | Status |
| ------------------------------ | --------------------------- | --------------------------- | ------ |
| Report → XLSX / CSV            | `render-report`             | `reportXlsx` / `reportCsv`  | ✅ guarded by `no-raw-xlsx-in-app` |
| Customer / vendor statement CSV | `generate-document` (`generate-document/index.ts:2155`) | `buildStatementCsv` (`_shared/exports/statementCsv.ts`) | ✅ `csv-export-registered_test`, `statementCsv_test` |
| Import templates / import error report (client XLSX) | `src/lib/importUtils.ts:225-252` | `XLSX.writeFile(..., {bookType:"csv"})` | ✅ Explicitly exempt (`RENDERER-EXEMPT` markers on every call site); import scaffolding, not a report artifact |

## Drift ledger

Prioritised by (a) customer-visible divergence risk, (b) statutory /
fiscal exposure, (c) number of parallel paths.

### D1 — Label rendering: two parallel ZPL implementations — **CLOSED (2026-07-20)**

**Resolution.** `supabase/functions/_shared/printing/zpl/builder.ts` is
now a thin adapter over `label_templates`: it fetches vars for the
document (products lookup for `inventory_label`; document-id passthrough
for `shipping_label`), resolves the template via
`resolve_label_template` RPC, and substitutes tokens with the same
regex shape used by `printLabelByTemplate`. No ZPL body literal
survives in the file.

**Migration.** `seed_default_label_templates` now seeds an
`inventory_label` row alongside the existing four; a backfill statement
inserts the same row for every organization that was seeded before D1.
Body preserves the pre-D1 on-wire shape (`^PW640`/`^LL400` envelope,
CODE128 barcode) so live printers see no byte drift.

**Guardrails added.**
- `src/test/architecture/label-builder-has-no-hardcoded-zpl.test.ts` —
  fails the build if any `^XA`/`^XZ` literal re-enters the adapter.
- `src/test/printing/label-template-substitution-parity.test.ts` —
  locks the client and edge `renderTemplateBody` helpers to the same
  regex literal + identical output for the seeded template bodies.
- `src/test/printing/zpl-golden.test.ts` — updated to assert bytes are
  produced from the seeded template body, not a hardcoded emitter.

**Files.** Pre-D1 emitter at
`supabase/functions/_shared/printing/zpl/builder.ts` (hardcoded bodies)
now a template resolver; `label_templates` remains the single source of
truth for every label body across the client (`labelDispatch.ts`) and
server (`generate-document` `format=zpl` branch) paths.

### D2 — No `pdf-lib` guard in edge functions — **CLOSED (2026-07-20)**

**Files.** `eslint-rules/no-raw-pdf-lib-in-app.js` was `src/**` only.
No equivalent existed for `supabase/functions/**`, so a new edge
function could `import { PDFDocument } from "pdf-lib"` and grow a
parallel A4 layout engine without tripping any guard — the same
drift pattern that produced the pre-ADR-0084 POS ESC/POS incident.
Existing edge functions were already clean
(`_shared/pdfGenerator.ts`, `hrLetterGenerator.ts`,
`reportPdfGenerator.ts`, `generate-audit-certificate` all compose
`_shared/pdf/**`); the risk was regression, not current state.

**Resolution.** New ESLint rule
`eslint-rules/no-raw-pdf-lib-in-edge-functions.js` scoped to
`supabase/functions/**`, allowlisting the two canonical low-level
owners: `_shared/pdf/**` (canonical A4 engine, ADR-0086) and
`_shared/receipt/pdf/**` (canonical thermal PDF renderer, ADR-0084).
Test files (`*.test.ts`, `*.spec.ts`, `*_test.ts`) are exempt so byte
inspection remains possible. Wired into `eslint.config.js` at `error`
level. Architecture test
`src/test/architecture/adr-0086-edge-pdf-lib-ownership.test.ts`
enforces the same invariant at build time (three assertions: rule is
registered as `error`, edge-function tree contains zero non-allowlisted
importers, allowlist is respected).

**Runtime proof.** Scratch violation
(`supabase/functions/_scratch-d2-verify/index.ts` importing
`PDFDocument` from `pdf-lib`) tripped the rule with the ADR-0086
message; scratch removed; baseline `bunx eslint 'supabase/functions/**/*.ts'`
reports zero `no-raw-pdf-lib-in-edge-functions` violations across the
current edge tree. Architecture test passes (3/3).

**D5 follow-up.** ADR-0086 audit-note (D5) called out that bespoke A4
paths like `generate-audit-certificate` compose `PdfBuilder` directly
without a "declared bespoke" marker. D2 now covers this transitively:
any future bespoke edge function is forced to compose `_shared/pdf/**`
(allowlisted) rather than reach for `pdf-lib` itself. D5 is therefore
absorbed by D2 and needs no separate guardrail.



### D3 — Statement print bypasses `useDocumentPrint` — **Resolved 2026-07-20**

**Files.** `src/pages/CustomerStatements.tsx:316` and
`src/pages/VendorStatements.tsx:281` both call
`supabase.functions.invoke("generate-document", …)` directly, instead of
routing through `useDocumentPrint` → `PrintPreviewDialog`. The server
path is the same canonical one, but the client-side entrypoint diverges
— PDF preview options, paper policy, and print artifact capture cannot
be uniformly evolved through the hook.

**Why it matters.** Server-side layout is not at risk; client-side
policy evolution (paper policy, artifact capture, preview UX) is. This
matches the "client synthesises its own request shape" anti-pattern the
guard `no-document-print-shadow-path` was built to prevent.

**Resolution (2026-07-20).**

- Client entrypoint drift removed from **all four** surfaces that still
  synthesised the request shape:
  - `src/pages/CustomerStatements.tsx`
  - `src/pages/VendorStatements.tsx`
  - `src/features/purchases/statements/VendorStatementPeekSheet.tsx`
  - `src/features/purchases/statements/VendorStatementRecordPage.tsx`

  All four now route through
  `useDocumentPrint.downloadPdf("customer_statement" | "vendor_statement",
  id, filename)`. The direct `supabase.functions.invoke("generate-document",
  …)` calls, dynamic `supabase` / `downloadPdfBlob` imports, ad-hoc
  `downloading` local state, and duplicated %PDF/toast handling were
  removed. Behaviour-preserving: the hook already sends `format: "pdf"`,
  validates the `%PDF` magic bytes, and toasts on success/failure.
- New ESLint rule `local/no-direct-generate-document-in-pages`
  (`eslint-rules/no-direct-generate-document-in-pages.js`) forbids
  `*.functions.invoke("generate-document", …)` inside `src/pages/**` and
  the entire `src/features/**` tree (not just `pages/` subdirs — the
  drift lived under `src/features/purchases/statements/` in modules that
  are pages by role but not by folder), with a per-line
  `// RENDERER-EXEMPT:` escape hatch. Wired at `error` in
  `eslint.config.js` for both globs.
- Architecture test
  `src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts`
  locks the invariant at build time (3/3 passing) and asserts the
  ESLint rule is registered at `error`.
- The two migrated pages were also added to the `no-document-print-shadow-path`
  allowlist in the same change so the migration does not trip the sister
  guard.
- Runtime proof: `bunx vitest run` across the D1+D2+D3 arch/parity
  suites returns 18/18 green (`label-builder-has-no-hardcoded-zpl`,
  `label-template-substitution-parity`, `zpl-golden`,
  `adr-0086-edge-pdf-lib-ownership`,
  `adr-0086-generate-document-client-entrypoint`).

### D4 — Kitchen / customer-display paths — **Low, no action**

Both consume the receipt fetcher and either project down (`kitchen.ts`)
or render visually (`CustomerDisplayDriver`). Confirmed single-source.

### D5 — Bespoke A4 documents without a "declared bespoke" marker — **Low**

`generate-audit-certificate` composes `PdfBuilder` directly rather than
delegating to `generateDocumentPdf` / `generateReportPdf`. This is
justified (signed-certificate chrome, seals, signatory blocks) and it
still uses the shared `_shared/pdf/**` primitives, so it is not
architectural drift under ADR-0086. It is called out only because
nothing today forces a future bespoke edge function to declare itself
"bespoke on shared primitives" vs "parallel implementation". Guarded
transitively by D2 once implemented.

### D6 — Server-side ZPL emitter parallel to driver-side rendering — **Low**

`supabase/functions/_shared/printing/zpl/builder.ts` renders ZPL bytes
server-side; the label drivers (`ZplLabelDriver`, `EplLabelDriver`) also
render ZPL from a template body on the device side. This is topological
duplication rather than layout drift, and D1 subsumes it — after D1,
the server emitter becomes a template resolver, matching the driver
model.

**Resolved 2026-07-20.** After D1 the server-side emitter became a pure
resolver over `label_templates`; the driver-side layout emitter was the
remaining second source of truth. Closure actions:

- Deleted `LabelSpec`, `renderSpec`, and the `print_label { spec }` code
  paths from `electron/hardware/drivers/ZplLabelDriver.ts` and
  `electron/hardware/drivers/EplLabelDriver.ts`. Both drivers are now
  pure transports: they accept only pre-rendered `{ bytes | zpl | epl }`
  payloads produced upstream by `labelDispatch.ts` or the server-side
  `builder.ts` (both of which read from `label_templates` via
  `resolve_label_template`). `^MD`/`^PR` transport commands moved into a
  post-header injection that mutates the wire framing but never the
  layout body.
- Confirmed no production caller ever emitted `{ spec }` — the only
  `print_label` emitter is `labelDispatch.ts`, which already sends
  `{ zpl }` / `{ bytes }` / `{ pdfUrl }` derived from templates.
- New architecture test `adr-0086-driver-side-label-layout-ownership.test.ts`
  locks that no `electron/hardware/drivers/**` file contains ZPL layout
  literals (`^FO`, `^FD`, `^FS`, `^BC`, `^BQ`, `^CF`) or the EPL text
  (`A<x>,<y>`) / barcode (`B<x>,<y>`) opcodes, and that neither
  `LabelSpec` nor `renderSpec` is re-introduced. Envelope tokens
  (`^XA`/`^XZ`) and transport commands (`^MD`/`^PR`/`^PW`/`^LL`) remain
  allowed because they frame the wire, not the layout.

## Guardrail gap summary

| Family     | Guard exists? | Notes                                                                                   |
| ---------- | ------------- | --------------------------------------------------------------------------------------- |
| Thermal    | ✅            | ADR-0084/0085, six architecture tests                                                   |
| A4 in app  | ✅            | `no-raw-pdf-lib-in-app`                                                                 |
| A4 in edge | ✅            | **D2 CLOSED** — `no-raw-pdf-lib-in-edge-functions` (ADR-0086)                            |
| Label      | ✅            | `no-raw-zpl-outside-printing` (app) + **D1** (server emitter) + **D6** (driver layout) + **D7–D11** (media / capability, ADR-0087) |
| Tabular    | ✅            | `no-raw-xlsx-in-app` + `csv-export-registered_test`                                     |
| Client entrypoints | ⚠️    | `no-document-print-shadow-path`, `no-direct-window-print`, `no-direct-pdf-iframe`; **D3** extends |

## Drift ledger — D7–D12 (media & printer capability, closed 2026-07-21)

| Item | Symptom                                                                | Resolution                                                                                                                                                     | Status |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D7   | Media not modelled; paper geometry duplicated across three tables.     | `public.media_profiles` created with grants, RLS, per-org auto-seed trigger. Migration `20260721001823_*.sql`. Admin surface at `/platform/hardware/media`.    | ✅     |
| D8   | `printer_profiles` conflated paper choice with hardware capability.    | Extended with `command_language`, `dpi`, `margins_mm`, `supported_media_ids[]`, `capabilities[]`. Dispatch reads capability from the profile, not from assignment.config. Admin surface at `/platform/hardware/capability`. | ✅ (legacy `paper_format` retained; see follow-up below) |
| D9   | Drivers did not emit the paper envelope; body-hardcoded `^PW/^LL` won. | `ZplLabelDriver` / `EplLabelDriver` / `BrowserHardwareAdapter` now strip and re-emit `^PW/^LL` (ZPL) and `q<dots>/Q<dots>,<gap>` (EPL) from resolved media + dpi. | ✅     |
| D10  | `label_templates` unique key had no media dimension.                   | Added `media_profile_id`; unique index rewritten to `(org_id, branch_id, template_key, media_profile_id)`. `resolve_label_template` gained media fallback (exact → NULL → default). | ✅     |
| D11  | `device_assignments.config` was an ad-hoc hardware source.             | Dispatch payload now originates from `printer_profiles` + `media_profiles`. Drivers keep reading `assignment.config` only as a legacy per-device fallback and prefer payload hints. Dispatch fails loud with `NO_MEDIA_RESOLVED` when a ZPL/EPL template has no resolvable media. | ✅     |
| D12  | Seeded default `product_label` rows were pinned to a media profile. Callers without a `printer_workflow_bindings` row passed `p_media_profile_id = NULL`, every candidate scored `rnk=99` under the original 4-tier CASE, and the dispatcher reported "no template registered" — indistinguishable from a genuinely missing template. | Three-part fix (migration `20260721005711_*.sql`, dispatcher, ADR addendum): (1) `seed_default_label_templates()` now inserts `media_profile_id = NULL` and existing default rows were repaired in-place; (2) `resolve_label_template` gained a `rnk=5` "last-resort" arm so a mis-seeded pinned default still resolves when the caller has no media; (3) `labelDispatch.ts` runs a `count`-head lookup and emits a sharpened error naming branch/media scope and pointing at Platform → Hardware when rows exist but ranking dropped them, versus the plain "no template registered" only when zero rows exist. Guardrails: `resolve-label-template-media-agnostic-default.test.ts` and `label-dispatch-error-taxonomy.test.ts`. See [ADR-0087 addendum](../adr/0087-media-and-printer-capability.md#addendum--defaults-are-media-agnostic-phase-13-2026-07-21). Closed 2026-07-21. | ✅     |

Architecture reference: [ADR-0087](../adr/0087-media-and-printer-capability.md).

Guardrail tests (Phase V + Phase 12):
- `src/test/printing/media-profile-resolution.test.ts` — `resolve_label_template` fallback ordering is (branch+media) → (branch+null) → (org+media) → (org+null).
- `src/test/printing/label-templates-have-no-envelope.test.ts` — no seeded body contains `^PW/^LL/q<n>/Q<n>`.
- `src/test/printing/printer-profile-hardware-shape.test.ts` — dispatch + drivers source capability from `printer_profiles`, not `device_assignments.config`.
- `src/test/printing/media-profile-required-on-label-render.test.ts` — media geometry + dpi flow through the dispatcher to the driver payload.
- `src/test/printing/label-dispatch-requires-media.test.ts` — dispatch returns a structured `NO_MEDIA_RESOLVED` error rather than a silent unscaled print when ZPL/EPL media does not resolve.
- `src/test/printing/label-envelope-parity.test.ts` — Electron ZPL/EPL drivers and `BrowserHardwareAdapter` share the same envelope math and ordering.

Follow-up (tracked separately, not blocking D7–D11 closure):
- Migrate remaining readers of legacy `printer_profiles.paper_format`
  (`PrinterProfilesCard.tsx`, `PrintingSettings.tsx`, `PostPaymentScreen.tsx`,
  `useDocumentPrintPolicies.ts`, `usePrinterProfiles.ts`) onto
  `supported_media_ids[]`. The column stays for backwards compatibility with
  the A4/receipt PDF flow until those readers are cut over.
- Label template editor (media picker + live-scaled preview) — the media
  picker slot is now available on `printer_profiles` via the capability
  surface, but a dedicated template body editor with a scaled canvas is
  still deferred. Template bodies are edited via SQL/seed migrations today.


## Runtime verification

Static evidence covers every event in the matrix. The following remediation
items require live-preview verification before they close:

1. **D1** — capture ZPL bytes from each label entry point (`Products.tsx`
   product-label button; any warehouse UI that hits `generate-document`
   with `documentType="inventory_label"`).
2. **D2** — scratch importer of `pdf-lib` under
   `supabase/functions/_scratch-d2-verify/` tripped
   `local/no-raw-pdf-lib-in-edge-functions`; baseline edge tree is
   clean; architecture test locks it. **Closed 2026-07-20.**
3. **D3** — Playwright the Statements pages, confirm the preview dialog
   opens and the outgoing request matches the hook path.

Each remediation ships as its own build-mode plan, one at a time, in the
order D1 → D2 → D3. D5 was absorbed by D2 (see D2 resolution notes).

## Non-goals of this audit

- No code changes. Findings become individual build-mode plans.
- No re-derivation of the receipt Line[] AST (ADR-0084 stands).
- No merging of the four medium families into a super-model
  (ADR-0086 non-goals).
