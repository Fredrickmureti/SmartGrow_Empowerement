
# Certificate architecture: audit, decide, complete

## 1. What I found in the codebase (verified, not claimed)

Two certificate architectures currently coexist end-to-end. Both are wired, both can render, and the edge function branches on `template.body.kind`.

**A. v2 structured (ADR-0060, "Odoo-shaped")**
- Schema `certificate_template_v2` registered in `pack_rule_type_schemas`.
- DB trigger `enforce_certificate_template_structure` + `trg_assert_certificate_template_body_valid` enforce the section contract at write time (migration `20260710214142`).
- Runtime structural refusal in `supabase/functions/generate-tax-certificate/index.ts` (lines 229–283) rejects any non-binary template missing `employer_header` / `employee_header` / `signature_block` / a data section — with a Deno unit test (`render_refusal_test.ts`) mirroring the branch.
- Renderers: `supabase/functions/_shared/pdf/certificateRenderer.ts` (804 loc, PDF) and `_shared/xlsx/certificateXlsxRenderer.ts` (361 loc, editable XLSX). Both consume the **same** `body.sections[]` + resolved payload — no divergent projection.
- Format registry gained `xlsx` writer (migration `20260712020735`) so a template can declare `outputs: [pdf, xlsx]` and both are produced from one section tree.
- Publisher UI: `CertificateTemplateEditor`, `CertificatePreviewPane`, `OutputsCard`, `TemplateFieldInspector`, token registry gate — publisher-driven, no code needed to add a country.
- Legal metadata (`authority_id`, `legal_reference`, `regulation_citation`, `effective_date`, `issued_to`) is first-class on `localization_pack_certificate_templates`; publish-time lint blocks packs missing it.

**B. Legacy binary-workbook overlay ("xlsx_binary")**
- `body.kind === "xlsx_binary"` → `binaryCertificateRenderer.ts` (220 loc, ExcelJS) opens a master workbook and stamps cells.
- Master bytes live in `localization_pack_binary_assets` (migration `20260710213828`), fetched inline / from Storage / from Lovable CDN via `LOVABLE_ASSETS_ORIGIN`.
- Dedicated `hydrate-localization-binary-asset` edge fn + admin-only `localization-assets` bucket (migration `20260712015253`).
- Kenya master pointer still present at `src/assets/localization/ke/KRA_P9_Master_2025.xlsx.asset.json`.
- Structural refusal is **explicitly bypassed** for `xlsx_binary` (line 244) — so a binary template can bypass every content check.
- UI still surfaces it as a typical certificate format (`OutputsCard: CERT_TYPICAL = {"pdf","xlsx_binary"}`, `TaxCertificates.tsx`, `ReturnsTab.tsx`).

## 2. Odoo comparison (independent reasoning)

Odoo's localization modules (`l10n_*_hr_payroll`, incl. Kenya) generate statutory certificates from **QWeb XML templates** rendered to PDF via wkhtmltopdf. There is **no binary master-workbook overlay infrastructure** in Odoo core or the Kenya module. Editable spreadsheet exports, when they exist, come from `report_xlsx` / the Spreadsheet module and are generated from structured data — never by overlaying a government-shipped .xlsx. Government logos are optional PNGs referenced by the QWeb template. Machine-format government files (CSV/XML) are a **Returns** concern, not a **Certificate** concern. Adding a new country is a pack-content exercise (new QWeb + Python data model), never a platform change.

**Conclusion:** the v2 architecture already matches the Odoo shape. The binary-workbook path is a Lovable-only invention with no enterprise precedent, it defeats every ADR-0060 gate (schema, tokens, lint, structural refusal), and it does not scale — each new country would need its own government workbook uploaded, SHA-pinned, hydrated, and cell-mapped by a developer. Retire it.

## 3. Output strategy (Odoo-aligned)

- **Certificates** (issued to an individual): **PDF is authoritative**. An optional **editable XLSX twin** rendered from the *same* v2 sections is acceptable (Odoo's `report_xlsx` model) and already implemented. No CSV, no XML — those are filing formats.
- **Statutory Returns** (employer-level bulk filings): keep CSV/XML/gov_xlsx paths. Out of scope for this work.
- **Reports** (analytics/exports): unaffected.
- Drop the "government master workbook" concept from Certificates entirely.

## 4. Plan of work

### Phase A — Verify (read-only, no blockers surfaced yet)
Grep call-sites to confirm nothing outside the listed files depends on `xlsx_binary` semantics; audit tests, pack seeds, and publisher docs for the same. Produce a short "removal blast radius" list before touching code.

### Phase B — Retire the binary-workbook path
1. Delete edge code: `binaryCertificateRenderer.ts`; strip the `xlsx_binary` branch (and the entire `renderBinary()` / asset-fetcher block) from `generate-tax-certificate/index.ts`; remove the `xlsx_binary` bypass in the structural refusal — every template goes through the v2 gate.
2. Delete the `hydrate-localization-binary-asset` edge function.
3. DB migration:
   - Drop `xlsx_binary` from `format_registry_writer_check` and from `format_registry` (writer + row).
   - Drop table `localization_pack_binary_assets` (empty in this env — will verify).
   - Drop the `localization-assets` storage bucket + its policies.
   - Add a `CHECK (body ? 'sections')` guard so future inserts cannot reintroduce `kind: xlsx_binary`.
4. UI: remove `xlsx_binary` from `OutputsCard.CERT_TYPICAL`, `TaxCertificates.tsx`, `ReturnsTab.tsx`, and the pack-declared-exports architecture test.
5. Delete `src/assets/localization/ke/KRA_P9_Master_2025.xlsx.asset.json` and the CDN asset behind it (`lovable-assets delete`).

### Phase C — Complete the v2 P9 / P9A / Certificate of Service content
1. Seed / correct the Kenya pack rows in a data migration so `P9`, `P9A`, `CERT_OF_SERVICE` v2 bodies are the canonical shipped versions, with full legal metadata (KRA authority, CAP 470 §37, effective 2025-01-01) and `outputs: [{format:"pdf",role:"primary"},{format:"xlsx",role:"editable"}]`.
2. Extend `certificateRenderer.ts` to reproduce the official KRA P9 grid **layout** (12 monthly rows × the 10 statutory columns from ADR-0060) using the existing `monthly_breakdown` section — no new section types unless a real gap appears. Add a KRA masthead band + statutory footnote as pack-provided strings, not hard-coded.
3. Mirror the same in `certificateXlsxRenderer.ts` (already section-driven; verify column widths, `=SUM()` totals, print area, A4 landscape).
4. **Blocker:** the official KRA P9 PDF/XLSX the user promised are not attached to this task. Before finalizing layout constants I need those files (or explicit confirmation to proceed from the columns/structure encoded in ADR-0060). I'll pause Phase C step 2 for that.

### Phase D — Publisher experience
- Verify `CertificateTemplateEditor` blocks save on missing legal metadata + unresolved tokens + missing required sections (already implemented — confirm end-to-end).
- Confirm the section palette exposes exactly the ADR-0060 whitelist and nothing else.
- Add a "Publish check" line item explicitly for certificate templates in the publish gate output.
- Document the publisher flow for adding a new country's certificate in `docs/adr/0060-certificate-template-parity.md` (appendix).

### Phase E — End-to-end verification
- Run Deno tests: `render_refusal_test.ts`, `certificateRenderer_golden_test.ts` (and update golden if the P9 layout changes).
- Vitest architecture tests: `pack-declared-exports.test.ts` (update expectations), any `xlsx_binary` references.
- `tsgo` typecheck; `bun run build`.
- Playwright: sign in, navigate HR → Payroll → Tax Certificates, generate a P9 for a seeded employee, download PDF + XLSX, screenshot both.

### Phase F — Documentation
- Update ADR-0060: add a "Rejected alternatives" section documenting the binary-workbook retirement + Odoo comparison.
- Add an ADR-0061 "Retire binary certificate workbook overlay" that references the removal migration.
- Update `docs/manuals/hr-payroll/10-payroll-documents.md`.

## 5. Technical notes

- The binary-workbook path was the **only** production dependency on `localization_pack_binary_assets`, `hydrate-localization-binary-asset`, and the `localization-assets` bucket — I'll re-verify with `rg` in Phase A before dropping.
- The v2 PDF and XLSX renderers already share `body.sections[]` and the resolved payload built by `resolveCertificateYtd` + `buildProjectedEmployeeMap` — that's the single canonical projection ADR-0060 requires; nothing to unify.
- KRA logo/seal: I'll **not** ship a government logo asset (matches Odoo). Employer branding (already resolved via `getOrganizationBranding`) stays.

## 6. Open question (needs an answer before Phase C step 2)

The official KRA P9 PDF and Excel weren't attached to the task. I can either (a) wait for them and match the exact grid pixel-for-pixel, or (b) proceed from the 10-column contract already documented in ADR-0060 and iterate once the files arrive. I'll ask before starting layout work.
