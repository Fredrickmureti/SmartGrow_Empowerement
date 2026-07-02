# ADR 0036 — Country-Agnostic Payroll & Localization Completion

**Status:** Accepted — 2026-06-13
**Owners:** Platform / HR-Payroll
**Supersedes / relates to:** ADR 0004, ADR 0010, ADR 0022, the Phase 5
pack-lifecycle closeout, and the country-agnostic payslip-header contract.

## Context

A complete architectural review of the Payroll + Localization ecosystem
was performed against Odoo, SAP SuccessFactors EC Payroll, Workday,
Oracle HCM (Legislative Data Groups), ADP, UKG, and ERPNext. The full
conformance matrix is in
`docs/audit/2026-06-13-payroll-localization-conformance.md`.

The review confirmed that **no area of the lifecycle remains
country-coupled** at the code level. The single Needs-Improvement item
— absence of a pre-publish lint surface for third-party publishers — is
closed in this change-set via the `lint-localization-pack` edge
function.

## Decision

The following invariants are locked. Any future change that violates
one of them must either ship a new ADR superseding this one or carry an
explicit `// LOCALIZATION-EXEMPT: <reason>` opt-out reviewed by
HR-Payroll.

### I1. No literal rule codes in engines
Enforced by `eslint-rules/no-literal-rule-codes-in-engines.js` and the
`no-hardcoded-country-payroll.test.ts` architecture test.

### I2. No literal ISO country codes in payroll / payslip / remittance / posting / certificate / return code paths
Enforced by the country-leak scan documented in §2 of the audit and the
`no-country-switch-in-payroll-ui.test.ts` architecture test.

### I3. Statutory identifier ownership
Employer identifiers live exclusively in `organization_statutory_identifiers`,
employee identifiers in `employee_statutory_identifiers`. Payroll never
owns identifier input UI — it only reads.

### I4. Pack-declared requirements drive identifier validation
`pack_requirements` is the only source of truth for which identifiers
are required for a given country / pack. Required-field logic in the
employee profile must not branch on country.

### I5. Single token resolver, single sentinel
`supabase/functions/_shared/renderTokens.ts` is the only path that
substitutes tokens at runtime. Unresolved tokens render as the
`‹unresolved: token›` sentinel and write a `payroll_diagnostics` row.

### I6. Pre-publish lint is mandatory
`publish-localization-pack-version` must call `lint-localization-pack`
and refuse to snapshot a version with `errors.length > 0`. The publisher
portal must surface lint errors before the publish button is enabled.

### I7. Atomic install, atomic uninstall
All install/uninstall paths go through
`install_localization_pack_atomic` and `uninstall_localization_pack`.
No edge function or client code may seed `payroll_statutory_rules`,
`localization_pack_*`, or `installed_localization_packs` directly.

### I8. Mapping integrity
All GL-mapping writes go through `payroll_apply_proposed_mappings` or
`payroll_create_and_map_account`. Direct writes to
`default_account_settings` from payroll code are forbidden (ADR 0022).

### I9. Payslip surface contract
The payslip PDF, the admin `PayslipDetailDialog`, and the employee
`MyPayslips` view consume `payslip_header` (RPC) + `payslip_lines`
(table) exclusively, with grouping driven by `payslip_lines.category`
via the shared `EARNING_CATS / DEDUCTION_CATS / EMPLOYER_CATS` sets.
Enforced by `payslip-header-country-agnostic.test.ts`,
`payslip-header-surface-contract.test.ts`, and
`portal-payslip-contract.test.ts`.

### I10. Engine country-neutrality verification
The synthetic-pack integration test exercises one rule of every
supported `computation_method` against `compute-payroll` to prove that
adding a country requires no engine code change.

## Consequences

**Positive**

- Adding a new country = author a pack + run lint + publish. No
  platform PR required.
- Third-party publishers have a first-class self-service surface.
- All cross-row consistency failures surface before publish, not at
  runtime during a tenant's payroll run.
- The audit deliverable + invariant list make regressions trivially
  reviewable.

**Negative / cost**

- Publishers must satisfy the lint gate. Packs that historically
  published with internal inconsistencies will need cleanup before the
  next version.
- Any engine extension (new `computation_method`) now requires three
  artifacts: the schema in `pack_rule_type_schemas`, the engine
  dispatch case, and a synthetic-pack test row.

## Out of scope

- Multi-language UI chrome (i18n of the app shell itself).
- Public marketplace for community packs (per ADR 0010).
- Non-payroll localization (accounting taxonomies).

## Related decisions

- **ADR 0046 — Payslip drill-down resolver.** Extends the country-agnostic
  guarantee from the engine (this ADR) into the explainer UI: every
  `input_ref` kind emitted by the engine is routed by a single pure
  resolver in `src/lib/payroll/payslipDrillDown.ts`, with no jurisdiction
  branching. The `payslip-input-lineage` architecture test fails CI if a
  new `InputRefKind` is added to the engine without a matching case in
  the resolver, keeping the audit chain (engine → `payslip_lines.source.input_ref`
  → explainer link → originating record) closed end-to-end.

