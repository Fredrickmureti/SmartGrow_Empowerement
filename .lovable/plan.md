
# Certificate Engine — Independent Audit & Completion Plan

## 1. Audit findings (verified against source, not the previous agent's status)

I traced every claim end-to-end. Bottom line: the block-AST architecture is real and wired, but the Kenya P9 template describes columns that the data source cannot provide, and the page orientation guarantees layout collapse. The renderer skeleton is fine; the pack is wrong on two axes and the renderer has one silent aggregation bug that hides it.

### What is genuinely in place (verified)

- `supabase/functions/_shared/pdf/certificateRenderer.ts` L173-174 dispatches to `renderCertificatePdfV2` whenever `body.schema_version >= 2`. The edge function `generate-tax-certificate/index.ts` L17 imports the dispatcher (not V1 directly), so runtime execution IS on V2 for KE.
- V2 renderer implements real primitives: `distributeWidths` (fixed/fr/auto), `wrapToWidth`, `ensureSpace`/pagination, repeat-header, footer totals, notes with border, signature slots, per-page footer with page numbers. Table engine is layout-driven, not coordinate-driven.
- Migration `20260712051100` sets `schema_version=2` and installs a `blocks[]` body for KE `P9`, `P9A`, `CERT_OF_SERVICE`, and publishes pack version `2026.8.0`.
- Editor: `BlocksEditor.tsx` (429 lines) plus v1/v2 toggle in `CertificateTemplateEditor.tsx`. Browser dispatcher mirrors the Deno one. Parity test exists.
- Provenance stamp on generation (`provenance.renderer = 'v2'|'v1'`) and `payroll_supersede_v1_certificates()` function exist.

Conclusion: the previous agent's D→F claims are structurally true. That is NOT why the P9 looks broken.

### What is actually broken (root causes of the ugly P9)

**A. The KE P9 template body references columns the data source cannot produce.** The `monthly_breakdown` resolver returns `MonthlyRow[]` with the shape `{month_index, rule_code, employee_amount, employer_amount, taxable_amount}` — a normalized rule-code stream. But the migration defines 17 KRA columns as semantic fields: `basic_salary, non_cash_benefits, housing_benefit, gross_pay, pension_30pct_of_basic, pension_contribution_actual, pension_statutory_cap, ahl_employee, shif_employee, prmf_employee, mortgage_interest_relief_base, total_relief_deductions, chargeable_pay, paye_gross, personal_relief, insurance_relief, paye_net`. Several of these (`pension_30pct_of_basic`, `total_relief_deductions`, `chargeable_pay`, `paye_net`) are computed, not rule codes at all. V2's group-by branch only fills a cell when `String(r.rule_code) === c.key` (renderer L653), so most KE P9 cells are blank or wrong.

**B. Portrait A4 with 17 columns is not renderable.** `body.page` is not set in the migration, so V2 defaults to portrait A4 (`computeLayoutV2` L191-194 → content width ≈ 525 pt). 525 pt / 17 columns ≈ 31 pt/column — narrower than a single formatted currency number (`KES 999,999.00` at 8.5 pt ≈ 62 pt). Headers wrap into 3–4 lines and cells cannot fit at all. This alone produces the "overlapping columns" the user sees. The KRA P9 spec is inherently landscape.

**C. `resolveFieldContext` employee shape is not what the payload provides.** V2 reads `pathGet(ctx.payload.employee, 'employee_number' | 'national_id' | 'position' | 'department')`, but the generator's employee payload is assembled from the employees join and typically nests those under different keys. This yields empty field-grid cells → the "cramped identity block" look.

**D. `notes` block has no min-width guarantee for wrapped titles**, and the `field_grid` `clip()` truncates long employer names with an ellipsis instead of wrapping to two lines. Minor but visible.

**E. Legal notes are pack-owned already** (verified in migration L104-110) — that claim is genuine. Publisher-editable via `BlocksEditor` NotesBlock panel — verified.

**F. Nothing hardcodes P9 in the renderer.** Grep confirms zero occurrences of `P9`, `KRA`, `Kenya` in `certificateRendererV2.ts` — the country-agnostic principle IS respected. The renderer is fine.

**G. The `pack_versions` insert uses `2026.8.0`, not v10.** The tenant upgrade proposal may or may not be produced depending on `propose-localization-upgrades` semantics — needs verification once the real fix is packed and republished.

### Odoo alignment check

Odoo's approach: reports are `ir.actions.report` + QWeb templates shipped by a localization module; the report engine is layout-driven (WeasyPrint/HTML+CSS), knows nothing country-specific; localization modules ship the QWeb template plus record rules; users override via inherited views. Our V2 architecture mirrors this: block AST is our QWeb, `renderCertificatePdfV2` is our report engine, `localization_pack_certificate_templates` is our module manifest, publisher edits via `BlocksEditor` are our inheritance mechanism. The gap vs Odoo is not the architecture — it is that our layer-1 data source (`monthly_breakdown`) is under-modeled for computed KRA columns. Odoo would expose a report-specific dataset (e.g. `hr.payslip.line` pivoted to a monthly matrix) rather than force the template to know rule codes.

## 2. Fixes (in dependency order)

### F1. Add a semantic monthly-matrix data source

Introduce `monthly_matrix` as a first-class resolver in V2 alongside `monthly_breakdown`. It returns one row per month with all payslip-line codes projected as columns AND with computed derived columns (`pension_30pct_of_basic`, `total_relief_deductions`, `chargeable_pay = gross_pay − total_relief_deductions`, `paye_net = paye_gross − personal_relief − insurance_relief`). The projection lives in a shared helper `_shared/monthlyMatrix.ts` so any country pack can consume it. This is the Odoo-equivalent of exposing a pre-shaped dataset; the template stays layout-only.

Signature: `projectMonthlyMatrix(rows: MonthlyRow[], derived: DerivedSpec[]): Record<string, number|string>[]`. `DerivedSpec` is `{ key, expr: 'a - b' | { min: [...] } | { pct: [x, 0.3] } }` — a tiny expression DSL, publisher-editable inside the template body (`derived_columns` on the TableBlock). This keeps derived math in the pack, not the platform.

### F2. Fix the group_by aggregation bug

Replace the "cell fills only when rule_code === column.key" branch (V2 L650-659) with: if data source is `monthly_matrix`, columns bind by row key (normal path). If data source is `monthly_breakdown` with `group_by`, sum `employee_amount` into `column.key` when `rule_code === column.key` (current behaviour, kept for other countries that project a small column set). This is a two-line branch, plus tests.

### F3. Landscape by default for wide tables + template flag

Set `body.page = { orientation: 'landscape' }` on the KE P9/P9A migration. Also add an editor control in `BlocksEditor` header for `page.orientation` (already implied by V2 layout code but not exposed in UI — verify and add if missing). No renderer changes needed — `computeLayoutV2` already honours it.

### F4. Field grid — wrap-to-2-lines instead of ellipsis-clip

Change `drawFieldGrid` to wrap the value with `wrapToWidth` capped at 2 lines and fall back to `clip` only for the third overflow line. Preserves grid rhythm while removing "Employer Name: Acme Manufa…" truncation.

### F5. Employee/employer payload contract

Publish an explicit contract doc (`docs/adr/0060-*-addendum-payload-contract.md`) and align the generator so `payload.employee` always contains: `full_name, employee_number, tax_pin, national_id, position, department, hire_date, termination_date`. Where the source data lacks a field, emit empty string, never undefined (prevents field-grid cells from silently vanishing).

### F6. Republish KE pack as version `10.0.0` (semver-aligned) via migration

New migration:
1. Rewrite P9 / P9A blocks to use `data_source: 'monthly_matrix'` with `derived_columns` for E1/J/K/O.
2. Set `page.orientation = 'landscape'`.
3. Insert `pack_versions` row `10.0.0` with changelog referencing this ADR addendum.
4. Fire `propose-localization-upgrades` fan-out (existing mechanism, no direct tenant writes).

### F7. Test surface

- V2 unit tests: `monthly_matrix` resolver, derived expressions, landscape width distribution across 17 columns, wrap-2-lines field grid.
- Golden test regenerated against new KE P9 body.
- Parity test (browser vs Deno) unchanged; both mirror files updated identically.

### F8. Regression sweep

Run existing tests for P9A, CERT_OF_SERVICE, Annual Earnings Statement, editor block palette, live preview, XLSX twin. XLSX twin still consumes `sections[]` (legacy) — verified untouched. Non-KE country packs untouched.

## 3. What I am explicitly NOT doing (and why)

- Not rewriting the renderer. It is layout-driven, honours widths/wrap/padding/repeat-header/pagination, and contains zero country tokens. Rewriting would be pure churn.
- Not embedding a KRA logo. Publishers can add via `image` block; platform ships none. Aligns with Odoo.
- Not attempting pixel parity with the government PDF. The user explicitly confirmed government files are specifications, not templates.
- Not touching V1 legacy path. XLSX twin still needs it; the ban on legacy templates is a downstream deprecation once every country pack is on v2.

## 4. Deliverables

- `supabase/functions/_shared/monthlyMatrix.ts` (new) + Deno test.
- V2 renderer: `monthly_matrix` resolver, aggregation branch fix, `drawFieldGrid` 2-line wrap. Mirror both Deno and browser files (parity test enforces this).
- `BlocksEditor` orientation control + `derived_columns` panel on TableBlock.
- Migration: KE P9/P9A body rewrite + `pack_versions` 10.0.0.
- ADR addendum: payload contract + `monthly_matrix` dataset contract.
- Vitest + Deno test additions; existing parity + golden tests kept green.

## 5. Verification plan (before I claim done)

1. `bunx tsgo --noEmit` clean.
2. `bunx vitest run` — all localization tests green including parity.
3. `supabase test edge-functions` — V2 renderer tests + monthly_matrix tests green.
4. `curl_edge_functions` against `generate-tax-certificate` for a seeded employee: inspect the produced PDF binary → `pdftoppm` → visually diff first page vs the KRA PDF spec (grouping, section order, column set, notes wording). No pixel parity; verify hierarchy and non-overlap.
5. Confirm `payroll_tax_certificates.provenance.renderer = 'v2'` on the new row.
6. Confirm a `pack_upgrade_proposal` row for pack v10 appears via the normal upgrade fan-out.
7. Regenerate P9A + Certificate of Service + Annual Earnings Statement to confirm no regression.

## 6. Open question for you

The current KE P9 migration is versioned `2026.8.0` (published today) but you asked for v10. I will republish as `10.0.0`. Confirm you want the semver reset to `10.0.0` rather than continuing the calendar-versioned `2026.9.0` line — either works, `10.0.0` is what your prompt says.
