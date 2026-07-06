# ADR 0060 — Certificate Template Parity with Return Templates

**Status:** Accepted — 2026-07-06
**Owners:** Platform / HR-Payroll
**Relates to:** ADR 0010 (pack versioning + tokens), ADR 0047 (statutory rules cockpit), ADR 0056 (localization publisher parity), 2026-06-30 statutory returns/remittances audit.

## Context

The Kenya localization pack is the reference implementation for future
country packs. The June 2026 publisher audit brought **return templates**
onto an enterprise-grade footing: first-class legal metadata, JSON-Schema
validation, dedicated publisher editor, and publish-time lint. **Certificate
templates were left behind.**

The gaps surfaced in three ways:

- Publisher-authored P9 template stored monthly rule codes as bare
  strings; when a publisher promoted them to `{key, code}` objects the
  renderer crashed with `key.replace is not a function` because nothing
  enforced the column shape.
- No `authority_id`, `legal_reference`, `effective_date` — auditors
  could not prove which statutory revision governed an issued P9.
- No schema in `pack_rule_type_schemas` for certificate bodies, so a
  typo in a `section.type` silently emitted an empty PDF band.
- Publisher editor was a thin wrapper around a generic template body
  editor; unknown section types were creatable, no legal-metadata
  fields, no realistic preview.

## Decision

Certificate templates now share the return-template publishing
contract:

### 1. Schema-validated bodies

`certificate_template_v2` registered in `pack_rule_type_schemas`:

- `data_source` — enum, currently `payroll_employee_ytd` only. This is
  the *only* canonical source a certificate may draw from — no direct
  reads of `payslip_lines` and no template-side recomputation.
- `sections[]` — required, minItems 1. Each section's `type` must be
  drawn from the whitelist: `employer_header`, `employee_header`,
  `fiscal_period_band`, `monthly_breakdown`, `ytd_table`, `totals`,
  `relief_summary`, `signature_block`, `statutory_footnote`.
- `footer_note` — optional legal footer string.

Trigger `trg_assert_certificate_template_body_valid` enforces the
schema on `INSERT`/`UPDATE`. Legacy pre-v2 bodies pass with
`legacy_unvalidated=true`; publish is blocked until they migrate.

### 2. First-class legal metadata

`localization_pack_certificate_templates` gains: `authority_id`,
`legal_reference`, `regulation_citation`, `effective_date`,
`sunset_date`, `revision_notes`, `issued_to`
(`employee|employer|both`), `approval_required`.

Tenant overrides may adjust `body` and `layout` only — legal metadata
is pack-owned. Mirrors the returns invariant enforced by
`return-override-legal-metadata-immutable`.

### 3. Publisher editor uplift

`CertificateTemplateEditor` is now a first-class editor:

- Legal-metadata form (authority picker sourced from
  `statutory_authorities`, legal reference, citation, dates, revision
  notes, issued-to, approval flag).
- Section palette — publisher picks types from the v2 whitelist. The
  UI cannot compose unknown section types; the DB rejects them at
  write time.
- Token field inspector (existing) blocks save while any `{{token}}`
  reference is unknown to `pack_token_registry`.
- Save-block conditions: unresolved tokens, missing required sections
  (`employer_header`, `employee_header`), missing legal metadata.

### 4. Publish-time lint gate

`publish-localization-pack-version` now:

- Snapshots `pack_rule_type_schemas` alongside pack-scoped tables — a
  pack version carries the exact validation rules that graded it, so
  future tenants can reproduce the check.
- Rejects publish if any certificate template lacks `authority_id`,
  `legal_reference`, or `effective_date`; is `legacy_unvalidated`; or
  fails the `certificate_template_v2` schema.

### 5. Kenya pack v-next content

Delivered through the standard `pack_upgrade_proposals` fan-out — no
tenant tables touched:

- **P9 Tax Deduction Card** rebuilt: employer/employee header, fiscal
  period band, monthly PAYE computation (Gross · NSSF · SHIF · AHL ·
  Chargeable Pay · Tax Charged · Personal Relief · Insurance Relief ·
  PAYE), YTD totals, statutory footnote citing Income Tax Act CAP 470
  §37, signature block.
- **Certificate of Service** added under Employment Act 2007 §51.
- Kenya Revenue Authority registered in `statutory_authorities`.

Existing tenant-issued P9s remain historical artifacts under
`payroll_tax_certificates` with their original template snapshot; the
upgrade proposal offers regeneration but never mutates a superseded
row.

## Consequences

**Positive**

- Certificate templates cannot silently drift from statutory
  requirements — schema + legal metadata + publish gate combine.
- Adding a country's certificate is now a pack-content exercise; the
  engine (`generate-tax-certificate`) is untouched.
- Publisher editor guides authors toward compliant templates; the
  `key.replace` class of runtime crashes cannot recur — the shape is
  fixed at save time.
- Pack version snapshots include the schema catalog, so tenant upgrade
  proposals show a faithful before/after even when the schema itself
  changed between pack versions.

**Negative / cost**

- Existing certificate templates authored before v2 must be re-saved
  in the editor to clear `legacy_unvalidated=true` before their pack
  can be republished.
- Publishers now have to fill legal metadata — a hard requirement
  that will slow first-country onboarding by minutes but pays back
  every time an auditor asks "which revision produced this P9?".

## Out of scope

- Non-payroll certificates (accounting attestations) — separate ADR
  when we have a first consumer.
- Multi-language certificate rendering — handled by the platform i18n
  track.
- Semantic diff for certificate templates in `pack_upgrade_proposals`
  — sits inside the ADR 0056 P2.b deferred track; the constraints
  there already anticipate this shape.

