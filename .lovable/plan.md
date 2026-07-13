# Certificate Publishing — Architecture Revision

## Verified state (independent audit, not the previous agent's claims)

| Previous agent claim | Reality on inspection |
|---|---|
| pdf-lib stack retired | ✅ Confirmed. `certificateRenderer(V2).ts`, `winansi`, `_monthlyMatrix`, xlsx renderer, goldens, parity tests are gone. Edge function has no `renderCertificatePdf` call sites; guard test enforces it. |
| v3 engine drives edge fn + editor + download | ✅ Confirmed. `generate-tax-certificate/index.ts` uses only `compileCertificateHtml`. Deno mirror and browser mirror of `compile.ts` are 315 lines each and structurally identical. |
| Editor is structured, no raw JSON | ⚠️ Partially. `CertificateV3Editor` is form controls, but binding paths are a raw text field (no schema/token picker), reordering is up/down buttons (no dnd), rich-text is a plain `<textarea>` splitting on newlines so per-run bold/italic/muted from the AST cannot be authored, legal-notice paragraphs can't carry bindings from the UI. This does not meet "publisher can design visually." |
| Country-agnostic engine | ⚠️ AST + compiler carry no country tokens (test verifies) — but `assertStatutoryPaper` in `_shared/pdf/index.ts` restricts to `a4` / `a4-landscape` only, a country/regulator assumption in a shared helper. |
| Step 3 headless PDF | ❌ Not started. Today's "PDF" only exists if a user hits Print in a browser. No server-produced PDF for email dispatch, e-filing, bulk export, or scheduled jobs. Stored artifact is HTML written as `text/plain` because the bucket MIME whitelist forbids `text/html` — a workaround that will bite when signed URLs are re-served. |
| Steps 4 (editor) & 5 (visual regression) | ❌ Not started. |

## Reading the two PDFs (KRA reference vs `System_Gen.pdf`)

The problem is not spacing — it's that the AST **cannot express what a statutory form is**.

**KRA reference — what the form actually is:**

```text
┌─ page master ────────────────────────────────────────────────────────────┐
│                          [KRA logo]  KENYA REVENUE AUTHORITY             │
│                              ISO 9001:2015 CERTIFIED                     │
│  APPENDIX 2A           KRA DOMESTIC TAXES DEPT — TAX DEDUCTION CARD YR   │
├──────────────────────────────────────────────────────────────────────────┤
│  Employers Name .........................  Employer's PIN ............   │  ← inline fill-in
│  Employee's Main Name ....................  Employee's PIN ............  │     "label ..... value"
│  Employee's Other Names .................................................│     lines, NOT a KV strip
├──────────────────────────────────────────────────────────────────────────┤
│              ┌── header stack (4 rows, uneven merges) ──┐                │
│  MONTH       │ Basic  │ Bnfts │ Val Q │ Gross │  Defined Contrib  │ AHL … │  ← label row
│              │ Salary │ NonC. │       │  Pay  │  Retirement  cs=3 │      │  (rowSpan varies)
│              │ Kshs.  │ Kshs. │ Kshs. │ Kshs. │      Kshs.        │ Kshs.│  ← unit row
│              │   A    │   B   │   C   │   D   │ E1 │  E2  │  E3   │  F   │  ← letter row
│              │        │       │       │       │30%A│Actual│30,000 │      │  ← sub-instr row
│  ────────────┼────────┼───────┼───────┼───────┼────┼──────┼───────┼──────┤
│  January     │        │       │       │       │    │      │       │      │
│  …           │        │       │       │       │    │      │       │      │
│  TOTAL       │        │       │       │       │    │      │       │      │
├──────────────────────────────────────────────────────────────────────────┤
│  To be completed by Employer at end of year                              │
│  TOTAL CHARGEABLE PAY (COL. K) Kshs. ............     TOTAL TAX (C ..... │  ← inline fill-in
├──────────────────────────────────────────────────────────────────────────┤
│  IMPORTANT                              c) Attach                        │  ← two-column
│  1. Use P9A                                (i) Photostat copy…           │     nested list
│     (a) For all liable employees…          (ii) DECLARATION duly signed  │
│     (b) Where an employee…                                               │
│  2. (a) Deductible interest…                                             │
│     (b) Deductible pension…                                              │
│     … (c)(d)(e)(f)                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

**Our output — what the current AST forces:**

- Employer / employee become a 2-column **`identity_strip`** with "EMPLOYER" / "EMPLOYEE" section titles. That is *report* language, not *statutory-form* language.
- The header stack collapses to 3 fixed rows (header, unit, sub-header). Column-letter and sub-instructions can't both exist. The letter row is jammed into the header text as `A · Basic Salary`.
- `column_groups` renders on **every** matrix, so our engine invents `Earnings / Defined Contribution / Statutory Deductions / Totals / Tax` — groupings that do not exist on the KRA form.
- End-of-year fill-in blanks (`TOTAL CHARGEABLE PAY (COL. K) Kshs. ...........`) are rendered as `key_value` rows — a different visual convention.
- The IMPORTANT block is a run-on paragraph inside a bordered box. There is no `list` primitive, no nesting, no two-column layout, no hanging indent, no marker style (`1`, `(a)`, `(i)`).
- Engine CSS bakes zebra striping, grey `#e9e9e9`/`#dcdcdc` header shading, muted `#555` labels, 7pt/6.5pt/5.5pt shrink-to-fit numerics with negative letter-spacing — presentation policy the pack cannot override.
- Page 3 emits a signature strip that the KRA P9A does not require here.

The AST is the ceiling on quality. No amount of CSS polish or editor rework on top of it will close this gap.

## Root causes (architectural, not cosmetic)

1. **`MatrixNode` cannot express the KRA header stack.** A statutory grid needs cell-level `colspan`/`rowspan` on the header block and independent rows per semantic level (label, unit, letter, sub-instructions). We hardcoded three optional rows and one column-groups row and called it done.
2. **`identity_strip` is the wrong primitive.** Real forms use inline `Label ......... value` fill-in lines with dotted rules — a *flowing* pattern, not a *columnar* one.
3. **No `list` node.** Every statutory notice on earth uses nested numbered lists.
4. **No `theme` on the template.** Engine CSS is opinionated; packs can't override typography, rule weight, header treatment, or zebra without inline `<style>` (which would leak into pagination).
5. **Editor is a form over nodes, not a designer over a page.** Publishers can pick a `matrix` and add columns; they cannot see a table draft and drag its column boundaries or merge two header cells. That is the difference the user is calling out.
6. **PDF is a browser side-effect.** Enterprise dispatch, e-filing, and bulk export require a deterministic server producer.
7. **Statutory paper allowlist is a leak.** `assertStatutoryPaper` hardcodes A4 — a country assumption in `_shared`.
8. **HTML artifact stored as `text/plain`.** Bucket MIME workaround will misbehave on re-serve; the stored artifact strategy needs a real fix (proper MIME whitelist, or render-on-demand and drop the stored HTML entirely).

## Revised plan

Six phases, each independently reviewable. Phase A is prerequisite to everything downstream; the previous agent's Step 3/4/5 sequencing was wrong because it assumed the AST was sound.

### Phase A — AST enlargement (highest leverage)

New / revised node types in `src/features/localization/lib/engine/types.ts` and the Deno mirror:

- **`grid`** — replaces `matrix`. Publisher authors:
  - `columns[]`: `{ id, width_mm | fr, align, format, wrap }` — the only structural definition per column.
  - `header_rows[]`: an array of *cell layers*. Each layer is an ordered list of `{ span: number, rowSpan?: number, content: Value | "column_letter" | "unit", align?, emphasis? }`. Publishers can add as many header rows as the form requires (label, unit, letter, sub-instructions, …) and merge cells with `span`/`rowSpan`. This is exactly what makes KRA-parity possible without a country primitive.
  - `data_rows`: `{ bind: string; index_column?: string }` — the tbody bound to a payload array.
  - `footer_rows[]`: same shape as header rows, but content can be `sum_of: "columnId"`.
  - `stripe`: `none | banded | alternate` — pack-owned.
- **`label_fill`** — inline "Label ......... value" statutory identity line. `{ label: Value, value: Value, rule: dotted | solid | none, value_width_mm | fr, label_bold?: bool }`. Multiple can flow inside a `field_row` container to place two per line ("Employer's PIN ..." next to "Employee's PIN ...").
- **`list`** — nestable ordered/unordered list. `{ marker: "1" | "a" | "A" | "i" | "•" | "(a)" | "(i)", items: Array<{ text: RichText, children?: ListNode }> }`.
- **`columns`** container — `{ count: 2 | 3, gap_mm, children: Node[] }` for the KRA `IMPORTANT / Attach` split.
- **`page_break`** — explicit break primitive (already implicit via section keep-together).
- **`theme`** on `CertificateTemplateV3` — pack-owned CSS variables:
  - `font_stack.body` / `font_stack.heading` (defaults: system-serif / system-sans, publisher can override with any web-safe stack; web font loading remains a future concern via `<link>` in page master).
  - `base_font_size_pt`, `rule_color`, `rule_weight_pt`, `header_shade`, `zebra`, `heading_case`, `numeric_letter_spacing`.
  - Engine CSS collapses to a **pagination reset** + `${theme.*}` substitutions. No engine aesthetics.

Removed:
- `MatrixNode` (superseded by `grid`).
- `IdentityStripNode` (superseded by `field_row` + `label_fill`).
- Engine-side CSS for zebra / shading / muted labels (moves to theme defaults, which the pack can zero out).

Migration:
- `keP9.ts` rewritten to use the new AST so its output matches the KRA reference — header stack with label/unit/letter/sub-instruction rows, inline `label_fill` identity, nested numbered `IMPORTANT` list in a two-column `columns` block, "TOTAL CHARGEABLE PAY (COL. K) Kshs. ....." row rendered via `label_fill`.
- All five existing v3 template rows in DB get an automatic migration to the new shape (a codemod, run once, guarded by a schema-version bump to 4). The DB validator (`assert_certificate_template_body_valid`) accepts schema_version 4.
- `assertStatutoryPaper` allowlist widened to A3/A4/Letter/Legal × portrait/landscape. Which paper is *legal* for a filing is pack metadata, not shared-helper code.

### Phase B — Renderer alignment

- Rewrite `compile.ts` (browser + Deno) to render the new AST. Deterministic, byte-identical between the two.
- Theme substitution via CSS custom properties emitted from `template.theme`.
- `grid`: colgroup + explicit `<thead>` with per-cell `colspan`/`rowspan` from `header_rows[]`; `<tbody>` bound from `data_rows.bind`; `<tfoot>` from `footer_rows[]` with `sum_of` computed against the bound array. `thead { display: table-header-group }` for paged.js repeat-across-pages.
- Update the compile unit tests (`certificate-engine.compile.test.ts`) and pin the new invariants (no country tokens, header_rows preserved verbatim, sum_of computes correctly, no engine-authored aesthetics).

### Phase C — Visual editor rewrite

New editor at `src/features/localization/components/CertificateDesigner/`. Replace `CertificateV3Editor` in the pack editor shell.

Two-pane layout:

- **Left: live paginated preview.** The same `CertificateHtmlSurface` used for the filed document. Publisher sees exactly what the tenant sees, at page scale.
- **Right: inspector.** Layer tree at top (dnd-kit reorder, nest, delete); selected-node inspector below.

Node-specific inspectors:

- **Grid designer** (the piece the user specifically called out — "like Excel"):
  - Spreadsheet-style header editor: rows = header layers, columns = data columns. Click a cell to edit its content (literal text / binding token / `column_letter` / `unit` reference). Drag a cell's right/bottom edge to increase `span`/`rowSpan`. Right-click to merge with next cell or split. Column widths dragged from the column ruler on top. Footer rows edited the same way with a `Σ` toggle per cell to bind to `sum_of`.
  - Column list on the side: `id`, format, align, width. Add/remove columns and the grid re-lays.
  - The whole grid renders live in the preview pane as the publisher edits.
- **Token picker** everywhere a `Value` is edited: an autocomplete over the current preview payload schema, walking dotted paths. `{{employee.tax_pin}}` shown with resolved sample value inline; unresolved paths highlighted red.
- **Rich-text editor**: inline contenteditable with a small formatting toolbar (bold/italic/muted). Serialises to the AST `paragraphs: [ [ { text, emphasis } ] ]` shape.
- **List editor**: marker picker, indent/outdent, nested drag.
- **`label_fill`**: label input + token picker for value + rule style + width slider (fr units or mm). A live preview of the resulting line.
- **Paper + theme**: paper size / orientation / margins on one card; theme controls (font stack, base size, rule weight, zebra toggle, header treatment) on another. All changes flush through the live preview.

Publisher never edits raw JSON. Import/export JSON remains available for advanced users behind a "Developer" toggle.

### Phase D — Deterministic server-side PDF producer

Recommendation: **Cloudflare Browser Rendering** binding (native to the platform's Workers runtime, same Chromium engine as the client preview, no external secret, deterministic pagination byte-for-byte with the preview). Fallback plan: a swappable `PdfProducer` interface with a Browserless HTTPS adapter, so a self-hosted deployment can point at its own headless Chromium.

Implementation:

- `supabase/functions/_shared/pdfProducer.ts`: `interface PdfProducer { render(compiledHtml: string, opts: { paper, margins }): Promise<Uint8Array> }`. Two adapters: `cloudflareBrowserRendering.ts`, `browserlessHttp.ts`. The active adapter is chosen by env.
- Update `generate-tax-certificate` to invoke the producer for every declared `pdf` output. Store the actual PDF bytes at `${basePath}.pdf` with MIME `application/pdf`, in addition to (or instead of) the HTML audit artifact.
- The `documents` bucket gets `application/pdf` on its allowlist (migration). The `text/plain`-for-HTML workaround is removed by making stored HTML optional and gated on `template.artifacts.include_html_audit`.
- Download hook: prefer the PDF artifact for user download; keep client-side paged.js preview for the editor and for on-demand re-materialisation from stored HTML when a pack ships that setting.
- Test: `render-refusal` and a new `render-parity` test compiles a sample template, produces a PDF via the producer, converts back to text with `pdf-parse`, and asserts key strings and cell counts.

### Phase E — Visual regression

- `src/test/localization/certificate-visual/` — one folder per template. Each has a synthetic payload JSON and a committed golden PNG (rasterised at 150 dpi).
- CI script: compile → producer → PDF → `pdftoppm` to PNG → `pixelmatch` against golden with a small tolerance. Diff artefact saved for review on failure.
- Also add a **structural diff** on the HTML: strip attribute quoting/whitespace and diff the DOM tree — catches AST regressions faster than pixels.

### Phase F — Cleanup

- Move `assertStatutoryPaper` allowlist into pack metadata; drop the helper's country assumption.
- Storage bucket MIME allowlist for `application/pdf` + `text/html`.
- ADR `docs/adr/00XX-certificate-engine-v4-ast.md` documenting the AST enlargement, theme model, and producer interface. Update `mem/features/certificate-rendering.md`.
- Retire `renderTemplateBody.ts` + related v2/v3 token collectors that were only kept for the v1/v2 fork already removed. `renderCertificatePdf` / `renderCertificateXlsx` bans stay in the architecture guard test; add bans for `identity_strip` and `matrix` node types once migration is complete.

## Sequencing

Each phase is one review pass. Non-negotiable order: A before B before D. C can start after A alongside B. E and F land last.

| Phase | What ships | Depends on |
|---|---|---|
| A | Expanded AST + Deno/browser types + template migration codemod + KE P9 template rewritten | — |
| B | New compiler for A; unit tests; delete matrix/identity_strip code paths | A |
| C | Visual designer editor (grid designer, token picker, rich-text, theme panel); replaces `CertificateV3Editor` in the shell | A (B strongly recommended so preview renders correctly) |
| D | `PdfProducer` interface + Cloudflare Browser Rendering adapter; edge fn writes real PDFs; bucket MIME migration | B |
| E | Visual + structural regression suite; pack lint gate | D |
| F | ADR, memory update, cleanup, ban tests | E |

## Country-agnosticism (verification for every phase)

Every PR touching `_shared/*`, `certificate-engine/*`, or `compile.ts` must pass the existing forbidden-token test *and* a new rule: no node type name is a country/regulator noun. `grid`, `label_fill`, `list`, `columns`, `field_row`, `theme` — none of these encode a jurisdiction. The KE P9 template is the first *consumer* of the enlarged AST, not the reason it exists; Ghana, Uganda, US W-2, UK P60 and any future pack must be expressible without engine changes.

## What I am **not** doing

- Pixel-perfect reproduction of the KRA PDF — the user explicitly ruled this out. Target is structural + information-hierarchy parity.
- Preserving the current `MatrixNode` / `IdentityStripNode` shapes for backward compatibility — the user confirmed there are no production users.
- Building on Step 3/4/5 as sequenced by the previous agent — that ordering assumed the AST was sound. It isn't.
