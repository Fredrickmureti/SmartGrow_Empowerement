
# Certificate Engine — Architecture Audit & Redesign

## Part 1 — Audit findings

I read both renderers (`supabase/functions/_shared/pdf/certificateRenderer.ts`, 822 lines; `src/features/localization/lib/pdf/certificateRenderer.ts`, 714 lines) and the surrounding schema/migration/parity work. The renderer is the root cause of the "unreadable P9". Landscape mode is not enough — the engine itself is not enterprise-grade.

### What is architecturally wrong

1. **The renderer knows what a P9 is.** The top-level `switch (type)` enumerates domain concepts: `employer_header`, `employee_header`, `monthly_breakdown`, `ytd_table`, `totals`, `relief_summary`, `statutory_footnote`, `signature_block`. Every new country either fits these buckets or the platform must ship code. That is exactly the coupling Odoo avoids (QWeb templates own the layout; the report engine owns primitives).

2. **English + KE-flavoured labels are hardcoded in the renderer**, not the pack:
   - `SECTION_LABELS` ("MONTHLY BREAKDOWN", "YEAR-TO-DATE TOTALS", "STATUTORY RELIEF", …).
   - `LABEL_MAP` ("Tax PIN", "Tax Office", "National ID", "Employee No." — KE/UK terminology).
   - `drawTotalsSection` hardcodes "Total Employee Deductions / Employer Contributions / Taxable Income" and reads only `payload.totals.{employee,employer,taxable}` — publishers cannot define their own totals.
   - `drawReliefSection` defaults to `["personal_relief", "insurance_relief"]` — Kenya-specific rule codes inside the platform renderer.

3. **The table primitive is not a real table.** It's coordinate math:
   - Column widths = `CONTENT_W / N` (equal split). Publishers cannot set fixed/fraction/auto widths.
   - No wrapping. `truncateToWidth` ellipsises values; header labels get **shrunk to as low as 6pt** to fit — this is what produces the "text over text" the user sees. It's not a KRA P9 problem; every wide table degrades this way.
   - No cell padding config; padding is `+4` sprinkled inline.
   - No repeated header when a table spills to page 2. `ensureSpace` starts a new page mid-row and the header vanishes.
   - No zebra rows, no vertical rules, no per-column format spec (currency vs date vs count vs text).
   - The monthly totals row is bespoke code, not a generic "footer row" concept.

4. **Legal wording lives in one place per section (`spec.body`) and only for the footnote.** The pack cannot declare declarations, IMPORTANT notices, filing instructions, or multi-paragraph legal blocks anywhere else. Notes are not a first-class block.

5. **Two hand-maintained renderers.** Deno-side and browser-side are kept in lockstep by a regex parity test comparing stringified `computeLayout`. Every future change has to be applied twice; the parity check only catches gross drift.

6. **No document primitives.** There is no `Heading`, `Paragraph`, `FieldGrid`, `Table`, `Notes`, `Divider`, `Spacer`, `Image`, `SignatureBlock` — just section-typed procedures. This is the opposite of the ADR-0060 intent.

7. **Country assets.** No government logo is hardcoded today (good), but there is also no `Image` primitive, so a publisher who *does* want to add one has no way to do so.

8. **Statutory paper guard** is fine (allowlist widened for a4-landscape); that piece can stay.

### What is architecturally right and should be kept

- `computeLayout(template)` deriving page size/orientation from `body.page` (Odoo `paperformat_id` parallel). Keep.
- `body.sections[]` as the pack-authored spine of the document. Keep — but redefine section types as *primitives*, not domain nouns.
- `assertStatutoryPaper` + `a4` / `a4-landscape` allowlist. Keep.
- Structured XLSX twin renderer already width-agnostic. No change needed.

### Verdict

Landscape mode makes P9 marginally readable but does not solve the underlying design flaw. Every future country will re-hit the same wall (wide tables, different totals nomenclature, different relief semantics, different legal boilerplate). **The renderer must be replaced with a block-primitive engine before more countries land.**

## Part 2 — Target architecture (Odoo-aligned)

**Split responsibilities cleanly:**

| Layer | Owns |
|---|---|
| Platform renderer | Page setup, fonts, block primitives, table layout engine, page-break/repeat-header, footer/pagination, i18n plumbing. **No section-type switch. No country strings.** |
| Localization pack | Document AST: which blocks appear, in what order, with what labels, columns, widths, formats, legal text, signature captions, optional images. |
| Data resolver | Named data sources (`employee`, `employer`, `monthly_breakdown`, `ytd_rows`, `custom_query`) that the pack references by name — pack never writes SQL. |

### Block primitives (the only types the renderer knows)

```text
Page              page-level metadata (already exists via body.page)
Heading           text, level 1/2/3, alignment
Paragraph         text (supports inline bold/italic via light markup)
FieldGrid         N-column label:value grid; auto-hides empty rows
Table             columns[{ key, header, width, align, format }],
                  data_source, rows|group_by, footer_row, options
                  { striped, repeat_header, wrap, padding }
Notes             heading + rich paragraphs (IMPORTANT, declarations,
                  filing instructions) — pack-authored, versioned
Divider / Spacer  layout rhythm
Image             optional publisher-supplied (logo, seal); base64 or
                  pack-relative asset id
SignatureBlock    N slots with configurable captions + optional date
```

Column `format` values: `currency` (uses `payload.currency`), `number`, `percent`, `date`, `text`. `width`: `"auto"`, `"1fr"`, `"2fr"`, or a pt/mm literal.

### What moves out of the renderer into the pack

- All section titles ("MONTHLY BREAKDOWN", "STATUTORY RELIEF", "SIGNATURES", …).
- All field labels ("Tax PIN", "Tax Office", "National ID", …).
- All totals labels and which totals to show.
- Relief codes and their captions.
- The footnote / declaration text and any other legal block.
- Column headers on the monthly table (A, B, C… in KE; different in every country).
- Signature captions.

### Table layout engine (the piece that fixes "text over text")

- Measure header + every cell, compute per-column intrinsic width, then distribute:
  1. Fixed-width columns first,
  2. `Nfr` columns share the remainder,
  3. `auto` shrinks to intrinsic width, up to a min.
- Wrap cell text to multiple lines with configurable `padding` and `line_height`; row height = max wrapped height across cells.
- Repeat header row after each page break; draw a "continued" marker on continuations.
- Optional footer row (totals) is a first-class row type with its own font weight and top rule.
- Alignment per column (`left | right | center`); numeric columns right-align by default.

This alone resolves the P9 legibility problem for every country simultaneously.

### One renderer, two runtimes

Collapse to a single source module and re-export it for both Deno and the browser via a thin platform-specific adapter that only handles font embedding. The parity regex test is replaced by a shared import — divergence becomes structurally impossible.

## Part 3 — Implementation phases

**Phase A — Renderer rewrite (platform, no country code). ✅ DONE.** `certificateRendererV2.ts` ships the block-primitive engine (Heading/Paragraph/FieldGrid/Table/Notes/Divider/Spacer/Image/SignatureBlock), a real table layout engine with intrinsic column measurement, fixed/fr/auto width distribution, wrapping with configurable padding+line-height, repeated header rows on page breaks, and first-class footer rows. Value-format registry (currency/number/percent/date/text). Dispatched by `renderCertificatePdf` when `body.schema_version >= 2`; v1 path untouched. 10 unit tests in `certificateRendererV2_test.ts`.

**Phase B — Schema v2. ✅ DONE.** `pack_rule_type_schemas` gains a `certificate_template / v2 / schema_version=2` row that accepts both legacy `sections[]` (for the XLSX twin during transition) and the new `blocks[]` AST with per-item type enums.

**Phase C — Pack migration. ✅ DONE (Kenya).** KE `P9`, `P9A`, and `CERT_OF_SERVICE` bodies rewritten to `schema_version: 2` with `blocks[]`:
- Employer/Employee `field_grid` primitives with pack-authored labels ("Employer KRA PIN", "Employee Number", …).
- Monthly PAYE `table` block with 18 authored columns (Month + KRA A–O), `group_by: "month_index"`, `1fr` widths that fit the landscape page, per-column right-align, striped rows, repeated header, `YTD Total` footer row aggregating each numeric column.
- Statutory `notes` block quoting Income Tax Act CAP 470 §37 wording, reliefs, and SHIF/AHL effectivity.
- `signature_block` with Preparer / Date / Employer Stamp slots.
- Certificate of Service uses `field_grid` (employer, employee, final year earnings) + `notes` + `signature_block`.
Legacy `sections[]` retained on the same body so the XLSX twin keeps working. Kenya pack version bumped to `2026.8.0` so upgrade proposals fan out through the normal flow. No renderer changes required to add South Africa `IRP5`, Ghana `P.A.Y.E.`, etc.

**Phase D — Publisher editor.** `CertificateTemplateEditor.tsx` gets a block-based editor (add/reorder/edit blocks) with a live preview using the same renderer.

**Phase E — Cleanup.** Delete the section-type switch, `LABEL_MAP` / `SECTION_LABELS` / relief defaults, the parity regex test, the browser-only `certificateRenderer.ts` duplicate, and eventually the legacy `sections[]` shape on template bodies (after XLSX twin also migrates to blocks). Update ADR-0060 accordingly.

**Phase F — Regeneration + supersede.** Bulk-supersede existing PDFs generated by v1 renderer (mark `stale=true` with `stale_reason='renderer_v2'`) so `download-tax-certificate` prompts users to regenerate — the mechanism already exists.

## Part 4 — Fork worth flagging (does not block the plan)

There are two credible ways to build the primitive engine:

1. **Stay on pdf-lib with a hand-written block/table layout engine.** No new infra, full control, more code to maintain. Recommended for now — matches current deployment shape (edge functions).
2. **Switch to HTML + CSS rendering** (headless browser or `@react-pdf/renderer`). This is closer to Odoo's QWeb→wkhtmltopdf pipeline; you get real CSS tables, `thead` repeat, and rich text for free — but it requires shipping a headless renderer in the Supabase edge runtime, which is nontrivial.

Recommendation: **Option 1** for this cycle; revisit Option 2 in a separate ADR once the primitive AST is stable (the AST is the same either way, only the drawing backend differs).

## Out of scope

- HTML/CSS renderer swap (separate ADR).
- Public pack marketplace, semantic diff, simulator — already deferred by ADR-0056.
- Government logo assets — remain publisher-supplied via `Image` primitive.

## Verification

- Regenerate KE P9 (landscape, 18 cols) and confirm: all headers render on one row unshrunken; long employer names wrap; header repeats on page 2 if the run spans it; totals row aligned; declaration/IMPORTANT block reads correctly.
- Regenerate Certificate of Service (narrow, portrait): unchanged layout, no regressions.
- Add a synthetic 25-column pack fixture and confirm the renderer degrades gracefully (auto column widths + wrapping, no overprint).
- New per-primitive unit tests + one country-agnostic golden test replacing the parity regex test.
- Existing pgTAP payslip-immutability country-agnostic scan continues to pass (renderer touches no payslip code).
