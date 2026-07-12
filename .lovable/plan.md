## Root cause (verified in code)

The V2 redesign the previous agent claimed **is** wired: `certificateRenderer.ts:173` dispatches templates with `body.schema_version >= 2` to `certificateRendererV2.ts` (1,025 LOC), and both the edge and browser paths share the same block AST. It's honestly country-agnostic — no `PAYE`/`P9`/`SHIF` tokens leak into renderer code (only doc-comment mentions).

So the ugly P9 is **not** because the redesign was skipped. The output is bad because the V2 engine itself is a **coordinate-drawing block layouter built on pdf-lib**. It cannot deliver statutory-grade layout no matter how many block primitives we add. What it lacks (and cannot cheaply gain):

- No real inline text shaper — wrapping is measured char-by-char against pdf-lib's `widthOfTextAtSize`, so KE P9's dense column headers ("Chargeable Pay", "Tax Charged", "Personal Relief") wrap vertically or overlap.
- No CSS-grade box model — padding/margin/border collapsing, min/max content sizing, and table auto-layout are hand-rolled and incomplete, hence the cramped columns.
- No `thead` repeat, no `page-break-inside: avoid`, no widow/orphan control — the 12-row monthly matrix breaks at arbitrary y-coordinates.
- No typography scale, no baseline grid — whitespace looks report-like because it is arithmetic, not typographic.
- Publisher edits blocks in a bespoke JSON editor — DX has no relationship to how anyone else in the industry authors statutory forms.

Rebuilding these primitives inside pdf-lib is re-implementing a browser layout engine badly. That's the architectural bottleneck.

## Industry evidence

- **Odoo** (`l10n_ke`, `l10n_za`, `l10n_us`): QWeb (HTML+XML) → wkhtmltopdf. Country packs are HTML template files.
- **ERPNext / Navari CSF_KE** (ships the actual Kenya P9): Frappe Print Format (Jinja HTML) → wkhtmltopdf.
- **Oracle HCM**: RTF → XSL-FO → PDF (BI Publisher).
- **SAP / Workday**: legacy proprietary form painters (SmartForms, Adobe Forms, BIRT). Even SAP is migrating new statutory forms to Adobe Forms flow subforms.

Dominant modern pattern for new statutory-compliance tooling: **flow-layout HTML/CSS rendered by a browser/paged-media engine**. Every peer that ships Kenya P9 today uses this pattern.

## Verdict: replace, don't evolve

Evolving V2 means re-implementing CSS paged-media on pdf-lib for the next several years. Replacing it is a smaller, bounded piece of work and matches how every serious ERP renders statutory documents. **Recommendation: replace the pdf-lib block engine with an HTML/CSS + paged-media pipeline.**

## Recommended architecture

```text
Localization pack (HTML template)          Renderer (country-agnostic)
─────────────────────────────────          ────────────────────────────
kra_p9.html.hbs   ← Handlebars over HTML   PdfRenderer.render(templateHtml, data)
kra_p9.css        ← Print CSS, @page,        1. Handlebars compile → HTML string
                    thead repeat, grid       2. POST to renderer service
kra_p9.schema.json← Data contract           3. Service runs WeasyPrint (Python)
kra_p9.assets/    ← Optional images/         → returns PDF bytes
                    QR (publisher-supplied) 4. Edge fn streams to caller / storage
```

**Engine choice: WeasyPrint (Python) in a small Fly.io/Cloud Run container.**

Why WeasyPrint over Chromium/Puppeteer:
- Purpose-built for CSS Paged Media Level 3 (`@page`, running headers, page counters, footnotes, `break-inside`, `thead` repeat). Chromium's paged-media support is weaker and quirkier.
- ~120 MB container vs ~600 MB Chromium; cold start <2 s.
- No JS execution surface → smaller supply-chain footprint for a signed statutory doc.
- Deterministic output (fonts pinned in container) → golden-file tests keep working.
- wkhtmltopdf is deprecated; we skip it.

Why not run in Supabase Edge Functions: Deno cannot run Chromium or WeasyPrint. Rendering moves to a dedicated microservice; edge fns become thin orchestrators that fetch data, compile the template, POST to the renderer, and persist the PDF. This is exactly Odoo's split (`ir.actions.report` orchestrator + wkhtmltopdf worker).

**Renderer's public API — country-agnostic:**
```ts
POST /render
{ templateHtml: string, css: string, data: object, assets?: {name, bytes}[], options?: {format, margins} }
→ 200 application/pdf
```
The renderer never sees the words "P9", "PAYE", or "KRA". It sees HTML and CSS.

**Publisher DX:** the certificate template editor becomes a two-pane HTML/CSS editor with a live preview iframe (the same WeasyPrint service, called with sample data). The block-primitive JSON editor and its bespoke React preview are retired.

## Migration impact

- **Rendering path**: `renderCertificatePdfV2` (edge + browser copies) deleted. `certificateRenderer.ts` becomes a 40-line orchestrator that calls the renderer service. `PdfBuilder.ts`, `components/`, `themes/`, `winansi.ts` retired.
- **Schema**: `certificate_templates.body` gains `schema_version = 3` = `{ html, css, data_contract, assets[] }`. Legacy v1/v2 templates still render via a compatibility shim (kept for 1 release, then removed) so installed tenants don't break mid-upgrade.
- **KE pack v10**: rewrite `kra_p9` as `kra_p9.html.hbs` + `kra_p9.css` matching the uploaded KRA PDF/XLSX blueprint (information hierarchy, monthly matrix, totals row, declaration + signature block, no government logo). Version bump propagates via existing `apply-localization-pack-upgrade` flow.
- **Publisher UI**: `BlocksEditor.tsx`, `PreviewPanel.tsx` block branch, `CertificateTemplateEditor.tsx` v2 branch replaced with `HtmlTemplateEditor` (Monaco for HTML + CSS, live preview via renderer service).
- **Tests**: `certificateRendererV2_test.ts`, `certificateRenderer_golden_test.ts` replaced with golden-PDF tests that hash the WeasyPrint output for a fixed data fixture per pack.
- **Infra**: one new service (`services/pdf-renderer/`, Python + WeasyPrint + FastAPI), deployed to Fly.io or Cloud Run. New secret `PDF_RENDERER_URL` + shared HMAC signing key.
- **Data**: no user-data migration. Payroll history untouched. Existing v2 templates in the DB keep working via shim until packs are upgraded.

## Files/modules affected

Deleted after cutover:
- `supabase/functions/_shared/pdf/certificateRendererV2.ts`
- `supabase/functions/_shared/pdf/PdfBuilder.ts`
- `supabase/functions/_shared/pdf/components/**`
- `supabase/functions/_shared/pdf/themes/**`
- `supabase/functions/_shared/pdf/winansi.ts`
- `supabase/functions/_shared/pdf/certificateRendererV2_test.ts`
- `src/features/localization/lib/pdf/certificateRendererV2.ts`
- `src/features/localization/lib/pdf/_monthlyMatrix.ts`
- `src/features/localization/components/BlocksEditor.tsx`

Rewritten:
- `supabase/functions/_shared/pdf/certificateRenderer.ts` → orchestrator that POSTs to renderer service
- `supabase/functions/generate-tax-certificate/index.ts` → adopt v3 dispatch; keep v2 shim for one release
- `src/features/localization/components/CertificateTemplateEditor.tsx` → v3 branch
- `src/features/localization/components/PreviewPanel.tsx` → iframe backed by renderer service
- `src/features/localization/lib/certificateCompleteness.ts` → v3 checks

New:
- `services/pdf-renderer/` (FastAPI + WeasyPrint + Handlebars-python, Dockerfile, HMAC verify)
- `supabase/functions/_shared/pdf/renderViaService.ts` (fetch + HMAC sign)
- `src/features/localization/components/HtmlTemplateEditor.tsx` (Monaco panes + preview)
- KE pack v10: `packs/ke/certificates/kra_p9.html.hbs`, `kra_p9.css`, `kra_p9.sample.json`
- New migration adding `schema_version = 3` support + v10 upgrade seed

DB migration:
- Add `body.schema_version = 3` shape validation to `publish-localization-pack-version`
- Seed KE pack v10 rows via `install-localization-pack` upgrade path

## Stop here for approval

I will not start implementation until you approve:
1. Replace (not evolve) the pdf-lib block engine.
2. WeasyPrint microservice as the renderer.
3. HTML+CSS+Handlebars as the publisher authoring format.
4. Retire the block-primitive V2 engine after a one-release compatibility shim.

If any of these four are wrong, tell me which and I'll revise.
