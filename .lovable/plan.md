
## Root cause (why the P9A came out broken)

The KE pack ships **three** statutory certificates:

| code | sections | authority | effective_date | verdict |
|---|---|---|---|---|
| `P9` | 7 | ✅ KRA | 2024-07-01 | v2 refresh landed here |
| `P9A` — *Tax Deduction Card (Low Income)* | **2** | ❌ | **1900-01-01** | **legacy stub, never refreshed** |
| `CERT_OF_SERVICE` | 6 | ❌ | 2024-01-01 | missing authority link |

The tenant generated `P9A`, not `P9`. `P9A.body.sections` has only 2 entries — no `employer_header`, no `employee_header`, no `monthly_breakdown`, no `signature_block`. The renderer therefore emitted its **legacy fallback columns** (`Month | Month | Basic Salary | Gross Pay | PAYE | Personal Relief | Net PAYE`) and its **legacy summary footer** (`Total employee deductions / Total employer contributions / Total taxable income`). That is exactly the PDF you're looking at.

ADR 0060's earlier work only patched one row (`code='P9'`). The linter didn't reject the sibling because `zero_sections`, `authority IS NULL`, and `effective_date < 2000` were not publishing gates. **The iceberg is real** — the same defect likely exists on `CERT_OF_SERVICE`, on return templates, and on every future pack that inherits the same seed shape.

## Objective

No tenant patch. Fix the **pack template contract** and the **publishing gates** so that any certificate/return template that ships without a valid section layout, without a linked authority, or with an epoch effective date cannot be published, cannot be rendered, and gets replaced everywhere via the existing pack-version fanout.

## Deliverables

### 1. Publishing gates (platform-wide, not tenant-specific)

Extend `lint-localization-pack` + `publish-localization-pack-version` with **hard-fail** rules applied to every certificate and return template in a pack:

- `sections` array must exist and contain at least one of each: `employer_header`, `employee_header`, `signature_block`, plus one data section (`monthly_breakdown`, `ytd_table`, or `totals`).
- `authority_id` required for anything with `legal_reference` OR anything whose `code` matches a statutory pattern (P9%, P10%, VAT%, PAYE%, NSSF%, SHIF%, AHL%, WHT%).
- `effective_date` required and must be `>= 2000-01-01`.
- `regulation_citation` required when `legal_reference` is set.
- Zero occurrences of the legacy `blocks[]` shape on statutory templates — `blocks` is now editorial-only.

Failures block `publish-localization-pack-version` and surface in the Publisher Health panel as **red** (not warning).

### 2. Retire the render-time legacy fallback (defence-in-depth)

In `generate-tax-certificate/index.ts`:

- If `template.body.sections` is missing, empty, or contains no `monthly_breakdown`/`ytd_table`/`totals`, **refuse to render** with error code `TEMPLATE_STRUCTURAL_INVALID` (400) instead of falling back to the ad-hoc column set. The user's PDF must never exist again.
- Remove the hard-coded `baseSummary` (`Total employee deductions / employer contributions / taxable income`). Totals come exclusively from the `totals` section spec.
- Refuse to render when `employer.tax_pin` is empty for a template whose authority is a tax authority — no unnamed statutory certificates.

### 3. Kenya pack refresh (v2026.4.0) — real content, not a stub

New migration seeds:

- `P9A` — full P9A "Low Income Employees" layout per KRA 2024 revision:
  - `employer_header` (name, tax_pin, address, tax_office)
  - `employee_header` (full_name, employee_number, tax_pin, national_id, position)
  - `fiscal_period_band` — Tax Year N
  - `monthly_breakdown` with KRA columns **A–K**: `basic_salary`, `benefits_non_cash`, `value_of_quarters`, `gross_pay`, `defined_contribution_retirement`, `owner_occupier_interest`, `chargeable_pay`, `tax_charged`, `personal_relief`, `insurance_relief`, `paye_net`
  - `totals` — YTD totals band using the same columns (not the deductions/contributions/taxable triad)
  - `signature_block` — preparer, employer_stamp, date + statutory certification sentence
  - `statutory_footnote` — Sec 37 Income Tax Act, retain for IT1
  - `authority_id` → KRA, `legal_reference` = Income Tax Act CAP 470, `effective_date` = 2024-07-01
- `CERT_OF_SERVICE` — attach a non-tax `statutory_authorities` row for the Ministry of Labour so the authority gate is satisfied without pretending KRA issues it. (New enum value `authority_kind = 'labour'` if not already present.)

New pack version `2026.4.0` published via `publish_localization_pack_version_sql` — snapshots into `pack_versions` and fans a proposal to every installed tenant. No tenant business data is touched.

### 4. Section-palette schema — extend for the new KRA columns

Add three column-source enums the resolver already needs but doesn't have:
- `benefits_non_cash`
- `value_of_quarters`
- `owner_occupier_interest`
- `defined_contribution_retirement` (min of 30% × chargeable, actual, KES 30,000/mo)

Wire them through `_shared/certificateSourceResolver.ts` as first-class YTD rule codes with clearly-marked provenance. The rollup RPC already supports arbitrary `rule_code` — no schema change to `payroll_employee_ytd_rollup` needed, only new registered rule codes in the KE pack.

### 5. Architecture tests (guardrails so this never recurs)

Add to `src/test/architecture/`:

- `certificate-sections-required.test.ts` — walks every seeded template row across every migration and asserts the section contract.
- `certificate-authority-linked.test.ts` — asserts every statutory-code template has `authority_id`, `legal_reference`, `regulation_citation`, `effective_date >= 2000-01-01`.
- `certificate-render-refuses-invalid.test.ts` — deno test on `generate-tax-certificate` calling with a hand-crafted invalid template body and asserting the 400 refusal.
- Extend `certificate-template-v2-schema.test.ts` to iterate `[P9, P9A, CERT_OF_SERVICE]` (currently P9-only).

### 6. Sweep other document surfaces (the rest of the iceberg)

In-scope for this plan, executed as separate migrations/tests once (1)–(5) land:

- `localization_pack_return_templates` — same three gates (sections/authority/effective_date). Enumerate what's currently seeded, patch every KE row that fails.
- `localization_pack_payroll_templates` — payslip layout audit against the same section contract.
- `localization_pack_bank_export_templates` — schema is different (fixed-width/CSV), but assert it has `authority_id`, `effective_date`, and a `spec_reference` (e.g. bank file spec version).

Each surface gets: (a) publishing gate, (b) architecture test, (c) refresh migration for KE, (d) publisher-health surface.

### 7. Publisher Health panel

Add three new checks so publishers see the state of the pack, not just the tenant:

- "Statutory templates without linked authority"
- "Templates with epoch effective_date"
- "Templates rendering via legacy fallback in last 30 days" (from `payroll_diagnostics` where `code IN ('TOKEN_UNRESOLVED','TEMPLATE_STRUCTURAL_INVALID')`)

---

## Technical notes

- **No tenant data written.** Everything flows through `localization_packs` → `pack_versions` snapshot → `pack_upgrade_proposals` fanout, which tenants accept explicitly.
- **Backwards compat:** the render-time refusal (deliverable 2) is gated on `template.pack_version_id >= v2026.4.0` OR unconditional after a two-week grace period — configurable per pack via a new `pack_versions.strict_render_from` timestamp. Prevents in-flight renders from breaking during rollout.
- **Rule-code registry:** the four new KE rule codes register in `localization_pack_payroll_rule_codes` (or equivalent — verify at implementation) so the `no-payslip-lines-in-certificates` ESLint rule keeps holding.
- **KRA P9A visual reference:** columns A–K, personal relief line = 2,400/month, insurance relief cap = 5,000/month, signature block wording per KRA 2024 P9A revision.

## Out of scope

- Patching the already-generated broken PDF for this tenant (per First Principle).
- UI polish on `CertificateTemplateEditor` beyond adding the four new column sources to the palette.
- Other-country pack refreshes (UG/TZ/NG P-equivalents) — those get their own plans once the platform gates are in place.

