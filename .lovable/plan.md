
# Certificate Rendering Engine — Audit & Enterprise Redesign

## Phase 1 — Independent Audit (verified against code)

Files inspected:
- `supabase/functions/_shared/pdf/certificateRendererV2.ts` (1,025 lines)
- `src/features/localization/lib/pdf/certificateRendererV2.ts` (1,025 lines — hand-mirrored copy of the Deno file, kept in sync by a parity test)
- `supabase/functions/_shared/pdf/certificateRenderer.ts` (v1, 831 lines, still live for `schema_version < 2`)
- `supabase/functions/generate-tax-certificate/index.ts` (dispatcher + payload assembly)
- `supabase/functions/_shared/pdf/PdfBuilder.ts` + `components/` + `themes/accountantMono.ts` (shared invoice/payslip builder — not used by certificates)
- `src/features/localization/lib/pdf/certificateRenderer.dispatch.ts`
- `docs/adr/0060-*`, `docs/printing-pipeline.md`

Verified facts:

1. **Two parallel renderers, hand-copied.** The V2 renderer exists twice (Deno edge + browser preview), kept aligned only by `certificateRendererV2-parity.test.ts` comparing switch-case labels. Any layout fix must be written twice and stay byte-identical modulo imports.
2. **pdf-lib is the layout engine.** The renderer manually tracks a y-cursor, measures glyph widths via `StandardFonts` + `winansiSafe`, and hand-computes column widths, wrapping, page breaks, and header repetition. There is no real layout engine — every visual defect (overlap, cramped columns, broken hierarchy) is a bug in ~1,000 lines of imperative geometry code.
3. **Block AST is layout-primitive, not document-semantic.** `Block` union = Heading / Paragraph / FieldGrid / Table / Notes / Divider / Spacer / Image / SignatureBlock. It has no notion of page master, header/footer band, running totals, columnar sections, or paged-media flow. Packs cannot express KRA P9's actual structure (declaration header band, two-column employer/employee identity strip, wide monthly matrix with per-column footer sums, legal notes footer, signature strip) without the renderer bolting on more primitives — which is exactly what ADR-0060 has been doing repeatedly.
4. **Renderer is not swappable.** `generate-tax-certificate/index.ts` imports `renderCertificatePdf` directly from `_shared/pdf/certificateRenderer.ts`, which itself branches to V2 by `schema_version`. There is no `PdfRenderer` interface — the "abstraction" is a file import.
5. **Shared `PdfBuilder` / themes / components exist but certificates don't use them.** `PdfBuilder`, `accountantMono`, `LineItemsTable`, `BrandedHeader`, `TotalsBlock` are the canonical builder for invoices/payslips (see `docs/printing-pipeline.md`). Certificates re-implement all of it. That is why payslips look consistent and certificates don't.
6. **Template body is JSON blocks stored in `localization_pack_certificate_templates.body`.** Publishers author it through `TemplateEditor` (form-based, not visual). There is no preview against the actual renderer beyond a browser mirror; no golden-PDF workflow for publishers.
7. **Upgrade path exists.** `usePackUpgradeProposals` + pack versioning are real and functional. Migration for a new pack version is a solved problem.

## Phase 2 — Root Cause

The Kenya P9 output is bad **not because the V2 primitives are wrong**, but because:

- The renderer is a **hand-rolled imperative layout engine** on top of pdf-lib. Real paged-media layout (measured columns, avoid-break regions, repeated table headers with running totals, keep-with-next, page-master headers/footers, precise typography) is an entire discipline; ~1,000 lines of ad-hoc y-cursor code cannot deliver it.
- The **block AST does not match statutory-form semantics**. KRA P9 (and every peer statutory form: SARS IRP5, IRS W-2, HMRC P60, URA, GRA, TRA) is a **paged report** with page masters, banded regions, and a wide matrix — none of which are first-class in the current AST. Publishers work around it by stuffing everything into `table` + `field_grid` primitives, so hierarchy collapses.
- **Two-file drift.** Every fix costs 2× effort and diverges over time. This has already led to layout regressions.
- **No feedback loop for publishers.** Editing a JSON block and hoping the imperative renderer draws it correctly is not an authoring model. Odoo publishers edit a QWeb XML template and see the exact same engine's output.

Conclusion: continuing to add primitives and geometry code to V2 is the wrong direction. **Replace the engine.**

## Phase 3 — Enterprise Redesign (Odoo pattern, internal)

Odoo's architectural principles (not implementation):

- Reports are **templates in a markup language** (QWeb XML) owned by the localization module, not by the platform.
- The **rendering engine is generic paged-media** (Odoo calls `wkhtmltopdf`; newer builds swap to a paged-HTML engine). The platform owns the engine; countries never touch it.
- Every report has a **paper format** (page size, margins, header/footer height) that is data, not code.
- Header/footer bands are separate templates rendered on every page by the engine — the report body just flows.
- Publishers add a new certificate by publishing a **template file** + **paper format** + **data mapping**; no platform release.

Applied here — **the platform owns a country-agnostic paged-HTML renderer; localization packs own templates.**

### Responsibilities

| Layer | Owns |
|---|---|
| **Platform** | Paged-HTML rendering engine; paper-format primitives; token/data resolver; page-master (header/footer band) runtime; PDF byte production; storage & lifecycle (unchanged) |
| **Localization pack** | Certificate template (markup), page master (header/footer markup), paper format, all labels/legal text/signature captions, monthly-matrix column definitions, i18n strings |
| **Publisher** | Authors templates in a visual editor that emits the markup; previews against the real engine; ships as pack version |
| **Rendering subsystem** | Pure function `(template, pageMaster, paperFormat, data) → PDF bytes`. No country knowledge. No pdf-lib geometry. Single implementation, single call site. |

### New template model (pack-owned)

```
certificate_template.body = {
  schema_version: 3,
  paper_format: { size: "A4", orientation, margins, header_height, footer_height },
  page_master_ref: "ke.p9.page_master.v10",     // header/footer band template
  document: <markup AST>,                        // typed nodes, not raw HTML
  data_bindings: { … tokens → payload paths }
}
```

`<markup AST>` node types are paged-media semantic, not visual primitives:
`Page`, `Band` (header/footer/body), `Section`, `IdentityStrip` (2-col employer/employee), `LegalNotice`, `SignatureStrip`, `Matrix` (wide table with column groups, per-column footers, repeat-header, keep-together), `KeyValue`, `Heading`, `RichText`, `Spacer`, `Image`. Publishers never see raw HTML/CSS.

### Rendering subsystem (single engine, internal)

- **One engine, one call site.** `renderCertificate({template, pageMaster, paperFormat, data}) → Uint8Array`. Lives in `_shared/certificate-engine/`. Called only by `generate-tax-certificate`. Browser preview calls the **same engine** compiled for the browser (no hand-copied mirror).
- **Engine internals** are a paged-HTML pipeline: AST → deterministic HTML+CSS (using CSS Paged Media: `@page`, `page-break-*`, `position: running()`, `element()`) → PDF. The engine is a Deno module; whether it invokes a bundled headless renderer or a WASM paged-media library is an **implementation detail decided in the implementation phase**, not now. The interface is stable regardless.
- **No third-party APIs.** Engine is internal to the ERP, same as Odoo owns its rendering.
- **pdf-lib retained only for post-processing** (merging, metadata, signing) — not for layout.

### Publisher experience

- Visual template editor in the pack workbench emits the typed AST (never raw markup).
- Live preview panel renders through the actual engine (WASM build) with sample payload.
- Publisher-supplied page master (logo, seal, QR) uploaded as pack asset; engine treats it generically.
- Golden-PDF test per template baked into pack CI.

### What gets deleted (once migration completes)

- `supabase/functions/_shared/pdf/certificateRendererV2.ts` and `certificateRenderer.ts`
- `src/features/localization/lib/pdf/certificateRenderer*.ts` (browser mirror)
- `certificateRendererV2-parity.test.ts` (no longer needed — one engine)
- Ad-hoc winansi + font-metrics code inside the renderer

## Phase 4 — Publisher Experience

Publishers author packs through the existing pack workbench, extended with:

1. **Template canvas** — drag/drop of the semantic node types listed above; property inspector for each node (labels, bindings, formatting).
2. **Page master editor** — separate document for header/footer band, referenced by templates.
3. **Paper format editor** — size, orientation, margins, band heights.
4. **Token binding picker** — reuses `pack_token_registry`; resolver already exists.
5. **Live preview** — same engine, sample payload, side-by-side with the canvas.
6. **Golden PDF** — publisher pins an approved PDF at pack-version publish; CI diff blocks regressions.

No platform code change is required to add a new country. Adding a new node type is a rare platform release, governed by ADR.

## Phase 5 — Migration Strategy

- **schema_version 3 = new engine.** V1 and V2 keep rendering unchanged until every active pack has migrated. `generate-tax-certificate` dispatches on `schema_version`.
- **Kenya pack v10** = first v3 template (P9), published through the existing `usePackUpgradeProposals` upgrade flow. Tenants get an upgrade proposal; nothing is force-migrated.
- **Deprecation window** (one pack cycle): v2 renderers stay in tree, marked deprecated, flagged in `payroll_diagnostics`.
- **Removal**: once no active pack version references schema_version < 3, delete the v1/v2 renderers, the browser mirror, and the parity test.
- **Provenance & lifecycle** (ADR-0036 Addendum) unchanged — engine swap is invisible to the ledger.

## Phased Implementation Plan (for approval)

- **Phase A — Engine core.** New `_shared/certificate-engine/` module: typed AST, resolver, paged-HTML compiler, engine entry point, unit tests. No integration yet.
- **Phase B — Dispatcher wiring.** `generate-tax-certificate` recognises `schema_version: 3` and calls the new engine; v1/v2 paths untouched. Feature-flagged.
- **Phase C — Kenya P9 v10 template.** Author the P9 as a v3 template + page master + paper format inside the KE pack. Golden-PDF baseline. Ship through the normal upgrade proposal flow.
- **Phase D — Publisher workbench.** Extend `TemplateEditor` with the canvas, page-master editor, paper-format editor, live preview using the same engine.
- **Phase E — Deprecate v1/v2.** Diagnostics warning; docs updated; parity test removed once no pack < v3 is active.
- **Phase F — Delete legacy renderers** and the hand-copied browser mirror.

Nothing under `PdfBuilder` / invoices / payslips is touched.

## Deliverables in this phase

- This audit + redesign document.
- No code changes.
- Approval gate before Phase A begins.
