# ADR 0061 — Retire the binary certificate workbook path

- **Status:** Accepted (2026-07-12)
- **Supersedes:** ADR 0060 §7 (which kept `xlsx_binary` installed
  alongside `certificate_template_v2` during the transition).
- **Related:** ADR 0056 (localization publisher parity),
  ADR 0060 (certificate template parity).

## Context

ADR 0060 introduced `certificate_template_v2` — a structured JSON
section contract (identity headers, monthly breakdown, totals, relief
summary, statutory footnote, signature block) validated by a DB trigger
and rendered by a single PDF renderer plus an editable XLSX twin. The
same ADR left the legacy `xlsx_binary` path installed so publishers who
had already shipped official master workbooks (uploaded to
`localization_pack_binary_assets` and rendered by
`renderBinaryCertificateXlsx` via a workbook-overlay engine) could keep
issuing certificates during the transition.

Two months in, the transitional path is entirely unused:

- `localization_pack_certificate_templates` — zero rows with
  `body.kind='xlsx_binary'`. All five installed templates (P9, P9A,
  Ghana PAYE, Certificate of Service, Annual Earnings Statement) are on
  the v2 section contract, with legal-reference metadata and
  outputs=`[pdf, xlsx]`.
- `payroll_tax_certificates.artifacts` — zero rows containing an
  `xlsx_binary` entry.
- `localization_pack_binary_assets` — two orphaned rows and no
  certificate template references them.
- `localization-assets` storage bucket — unused.

Odoo's enterprise localization stack for the same class of documents
(Kenya P9 / P9A, Ghana PAYE, Belgium fiches, Italian CUD, French DSN
certificates) is entirely structured: QWeb XML templates fed by
`hr_payroll_ytd` rollups, one PDF renderer per certificate, no binary
workbook overlays. Nothing in Kenya's or Ghana's statutory posture
requires binary parity — the KRA accepts A4 PDFs generated from an
employer's payroll system as long as they carry the same column
identity (A–O), employer/employee identity, and signature block that
the v2 renderer already emits.

Keeping `xlsx_binary` alive imposes real cost:

1. It bypasses the `enforce_certificate_template_structure` DB gate,
   because the gate exempts `body.kind='xlsx_binary'`. Any pack
   publisher can silently ship a certificate with no identity headers,
   no signature block, and no reconciliation totals — the exact
   failure mode ADR 0060 was written to close.
2. It requires a running hydration edge function
   (`hydrate-localization-binary-asset`) plus an assets-CDN origin
   (`LOVABLE_ASSETS_ORIGIN`) plus a `localization-assets` storage
   bucket. Three moving parts, none used in production.
3. It forces every new localization pack author (Uganda, Rwanda,
   Tanzania, Nigeria, South Africa …) to decide between two shapes and
   maintain a binary master. The default should be one shape.

## Decision

Retire `xlsx_binary` completely.

1. **Renderer.** Delete
   `supabase/functions/_shared/pdf/binaryCertificateRenderer.ts` and
   the `renderBinary` branch inside `generate-tax-certificate`. The
   default output for a certificate template with no explicit
   `outputs[]` is `pdf`.
2. **Hydrator.** Delete the
   `supabase/functions/hydrate-localization-binary-asset` edge
   function.
3. **Data.** Drop the `localization_pack_binary_assets` table, the
   `format_registry` row for `xlsx_binary`, and the
   `pack_rule_type_schemas` row for `xlsx_binary`. The unused
   `localization-assets` storage bucket is retired via the Supabase
   Storage UI (direct DELETE is blocked by a safety trigger).
4. **Structural gate.** With no binary bypass left, the
   `certificate_template_v2` contract enforced by
   `enforce_certificate_template_structure` is now the *only* accepted
   certificate shape. The runtime refusal in
   `generate-tax-certificate/index.ts` no longer whitelists
   `body.kind='xlsx_binary'`.
5. **UI.** The Localization Publisher's Outputs card now offers only
   `pdf` and `xlsx` as "typical" certificate outputs. The Payroll →
   Tax Certificates list stops rendering the `xlsx_binary` label; the
   editable XLSX twin surfaces as "Excel" the same way it does for
   returns.

### Output strategy for certificates

- **Authoritative:** PDF (A4, statutory paper pin). One per employee
  per fiscal year per template.
- **Optional editable twin:** XLSX rendered from the same v2 sections
  and the same resolved payload. For auditors and payroll analysts
  who want to filter/pivot the monthly breakdown. Not signed, not
  authoritative.
- **Machine formats (CSV / XML / gov_csv / gov_xlsx / gov_xml):**
  reserved for *statutory returns* (PAYE monthly return, NSSF return,
  SHIF/NHIF return, AHL return). Individual employee certificates
  never emit machine formats.

## Consequences

- Every localization pack — Kenya today, Uganda / Ghana / Rwanda /
  Tanzania / Nigeria / South Africa next — ships certificates as
  `certificate_template_v2` JSON. Adding a country is data, not code.
- The `enforce_certificate_template_structure` DB trigger becomes the
  single choke point for certificate shape correctness. A pack that
  omits identity headers or a signature block cannot be published.
- Historical certificates issued via the (dormant) binary path remain
  downloadable through their `payroll_tax_certificates.pdf_path` /
  `xlsx_path` scalars; the UI now labels the XLSX artifact "Excel"
  regardless of which renderer produced it.
- Publishers who genuinely need pixel-perfect binary parity with an
  official workbook (rare — Odoo does not offer this either) must
  request the feature explicitly. We will re-introduce a bounded
  binary-overlay path only if a real statutory authority mandates it.

## Tests

- `src/test/architecture/pack-declared-exports.test.ts` — asserts the
  structured PDF and XLSX certificate renderers exist and the legacy
  `binaryCertificateRenderer.ts` symbol is no longer referenced.
- `supabase/functions/generate-tax-certificate/render_refusal_test.ts`
  — continues to enforce the identity + data + signature contract on
  every template, now without the `xlsx_binary` bypass.

## Migration

`retire the legacy binary certificate workbook path` (2026-07-12) —
drops the format registry row, the pack rule-type schema, and the
`localization_pack_binary_assets` table. The `localization-assets`
storage bucket is deleted separately from the Storage UI.
