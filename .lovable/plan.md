# Fix statutory document publishing: collapse to one HTML-based engine + WYSIWYG editor

## Verdict (why the P9 looks broken)

The certificate stack carries **three renderer generations at once** and the KRA P9 has been rewritten between them ~8 times in one day (all `20260712*` migrations). That churn is the credit-burn you saw.

- **v1** `certificateRenderer.ts`, **v2** `certificateRendererV2.ts`, **v3** `certificate-engine/`.
- Your P9 today renders through **v2 (pdf-lib), portrait-cramped** — 17 columns hand-drawn with `drawCell`, which **truncates** headers (`…`) and cannot wrap, cannot stack the `Kshs.` units row or the A–O letter row, cannot nest E→E1/E2/E3. No amount of tuning fixes this; pdf-lib is a low-level *drawing* library, the wrong tool for a statutory grid.
- The **right renderer already exists**: v3 `compile.ts` turns the country-agnostic AST into **HTML + CSS Paged Media** (real tables: colspan groups, wrapping, landscape, repeating headers) and already has a passing P9 blueprint test. But its HTML is thrown away — the PDF is re-drawn in pdf-lib (`astPdfProducer.ts`). So **preview ≠ output** by design, and neither matches the form.

This mirrors how Odoo/SAP/Workday work (one declarative layout + one render engine, preview == output, engine never knows "P9"). You built the correct core, then refused to render from it. We stop building on the pdf-lib path and make the compiled HTML the single source of truth.

## Decisions (from your answers)
- **Render client-side in the browser** from the compiled HTML → preview and filed document are identical by construction, no external infra.
- **Collapse to v3 only** — delete v1 + v2 renderers/editors and the pdf-lib AST producer.
- **Structured WYSIWYG editor + live preview** replacing the JSON textareas.

## Architecture after this change

```text
 pack AST (country-agnostic)         ── authored in WYSIWYG editor, stored on template.body (schema_version 3)
        │
   compile() ── AST → HTML + CSS Paged Media   (ONE layout source, shared by preview AND output)
        │
   paged.js in an <iframe>  ── faithful pagination, landscape, grouped headers, wrapping
        │
   browser print pipeline ── the PDF artifact (vector text, KRA-accurate)
        │
   slim edge fn ── resolves payload (server, RLS-safe) + stores bytes, serial, issued-row, supersede, diagnostics
```

The engine stays country-agnostic: P9 layout lives entirely in the KE pack row, never in code.

## Work plan

### 1. Make compiled HTML the single renderer (client-side)
- Promote `certificate-engine/compile.ts` to a browser-safe shared module (it is pure string building; strip Deno-only bits).
- Add **paged.js** as a dependency. New `CertificateHtmlSurface` renders `compile()` output in a sandboxed iframe with paged.js — used by both the editor preview and the issue/download flow.
- Rewrite `CertificatePreviewPane` to use this surface instead of the pdf-lib dispatch, so preview is exactly the filed layout.
- Wire the artifact-producing "download/print/issue" actions to the same paged HTML via the browser print-to-PDF pipeline (extends the existing `src/services/printing` pattern to an HTML surface).

### 2. Extend the AST just enough for statutory grids (stays generic)
`compile.ts` today renders only a group row + header row. To express the KRA form generically (no country logic), add:
- Multi-row matrix headers: per-column optional `sub_header` (the A–O letters) and `unit` caption (the `Kshs.` row), plus nested `column_groups` with sub-column spans (E over E1/E2/E3).
- A pack-authored totals/footer row and a `legal_notice` block for the "IMPORTANT / To be completed by employer" text.
These are generic column/row primitives; any country can use them.

### 3. Migrate templates to v3 and delete the old paths
- New migration: rewrite KE **P9**, **ln**, **CERT_OF_SERVICE** to `schema_version: 3` landscape AST (A–O columns, E1/E2/E3 group, units + letter rows, employer/employee identity strip, KRA masthead in `page_master`, legal notice, signature strip). This is pack data only.
- Update `pack_rule_type_schemas` + the body validators (`enforce_certificate_template_structure`, `assert_certificate_template_body_valid`) to accept **only v3**.
- Delete: `certificateRendererV2.ts` (both mirrors), `certificateRenderer.ts` v1 path, `astPdfProducer.ts`, `BlocksEditor.tsx`, the section-palette code in `CertificateTemplateEditor`, and the now-dead eslint rules/tests (`no-payslip-lines-in-certificates` stays; `certificateRendererV2_test`, golden tests re-pointed to compile()).
- Keep `assertStatutoryPaper` (now allows `a4` + `a4-landscape`) as a guard on the template's `paper_format`.

### 4. Rebuild the editor as a structured WYSIWYG designer
Replace JSON textareas in `CertificateV3Editor` with:
- Paper format controls (already structured — keep).
- Page-master header/footer node builder.
- Document node builder: add/reorder/remove `heading`, `rich_text`, `identity_strip`, `matrix`, `legal_notice`, `signature_strip`.
- A real **matrix column/group builder** (add columns, set header/sub-header/unit/format/align/width, define column groups) — this is the piece that makes it feel like Odoo/SAP.
- Live preview pane bound to the same `compile()` HTML, so authoring is truly WYSIWYG.
- Binding picker reusing `TokenPicker`/`TokenRegistryEditor` so data paths are chosen, not typed.

### 5. Server lifecycle (keep audit, drop server rendering)
- `generate-tax-certificate` becomes: resolve payload + template server-side (unchanged data assembly, RLS, idempotency checks) and return them to the client for rendering; a companion path accepts the client-rendered bytes to store in `documents`, assign serial, write/supersede the issued row, and log diagnostics.
- Batch issuance renders per employee in a loop with progress (same per-record model Odoo uses).

## Technical notes / risks
- **Byte capture**: faithful vector HTML→PDF in-browser uses paged.js layout + the browser print engine; issuance is an admin/loop-driven action (documents produced at issue time, then downloadable from storage). No headless service needed.
- **Determinism**: stored certs are versioned/superseded rows, so per-render byte stability is not required (matches current behaviour of creating a new issued row on regenerate).
- **Migration safety**: template rewrites are pack-data migrations; no `.git`/schema-reserved changes. The old renderers are deleted only after the v3 templates validate and preview correctly.
- This ends the multi-generation thrash: after this, there is exactly one layout language, one render path, one editor.

## Suggested build order
1. compile() browser module + paged.js preview surface (proves the look on the existing P9 test data).
2. AST/compile extensions for multi-row headers + groups.
3. KE P9 v3 template migration + validator lockdown.
4. WYSIWYG editor rebuild.
5. Server lifecycle slim-down + delete v1/v2/pdf-lib paths + test/eslint cleanup.
