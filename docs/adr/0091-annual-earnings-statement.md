# ADR-0091 — Annual Earnings Statement (country-neutral)

Status: Accepted · 2026-07-23

## Context

The Annual Earnings Statement before this ADR had blank YTD totals,
missing employer address, missing employee department/position, columns
that did not match the bindings, no versioned DTO, no content hash, and
no localization extension registry — so a country pack could only override
by cloning the whole template.

Mature payroll systems (Workday, Oracle HCM, SAP SuccessFactors, Odoo,
D365) treat the annual statement as a canonical, deterministic view of
the payroll ledger, with jurisdiction certificates (P9, P60, IRP5, SSNIT
reporting) as extensions grafted onto that base.

## Decision

1. Versioned DTO. AnnualEarningsStatementDTO v1 is the single contract
   between resolver and every renderer/template.
2. Single writer. resolveAnnualEarnings() is the only path that
   materialises the DTO. It delegates aggregation to
   resolveCertificateYtd — no template-side arithmetic.
3. Deterministic. provenance.content_hash is a canonical-JSON SHA-256
   over the DTO minus issuance metadata. Regenerate five years later
   against the same immutable payroll history → identical hash.
4. Country-neutral base. The ANNUAL_EARNINGS_STATEMENT template contains
   zero country tokens. Enforced by
   architecture.annual-earnings-country-agnostic.test.ts.
5. Extension registry. payroll_certificate_template_extensions lets a
   localization pack publish appendix bodies keyed by region. The base
   template declares extension_region nodes; the edge function splices
   installed pack bodies in at compile time. Uninstalling a pack retracts
   the appendix automatically.
6. Dedicated dispatcher. generate-annual-earnings-statement is separate
   from generate-tax-certificate so the neutral document is never
   contaminated by certificate-specific engine payload overrides.
7. Self-service. /me/annual-earnings exposes the statement to the
   employee; the edge function bypasses payroll.read when the caller is
   the target employee.

## Invariants

- Base statement code path contains no country tokens.
- All monetary values on the statement come from payslip_lines via
  resolveCertificateYtd.
- Templates describe presentation only; every calculation lives in the
  resolver.
- Pack appendices are additive; they cannot mutate the base DTO.
- dto_version + content_hash travel with every generation.

## Consequences

- Country certificates ship as pack extension rows — no engine fork.
- The blank-YTD document is fixed at the root: the DTO now carries YTD
  totals, monthly matrix, and category breakdowns.
- Regeneration is reproducible and auditable via content_hash.

## Follow-ups

- Persist a payroll_annual_earnings_issuances audit row per render.
- Employer-side batch issuance from the payroll admin surface.
- Optional storage-backed PDF artifacts (currently rendered on-demand).
