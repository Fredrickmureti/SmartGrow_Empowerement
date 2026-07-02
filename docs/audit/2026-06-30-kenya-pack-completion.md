# Kenya Localization Pack — Completion Audit (2026-06-30)

Pack: `Kenya Fiscal Localization` (id `a1b2c3d4-…-ef1234567890`), version `2026.1.0`.

## Audit method

Compared the pack's seeded artifacts (`payroll_statutory_rules`,
`localization_pack_return_templates`, `…_certificate_templates`,
`…_remittance_schedules`, `…_garnishment_kinds`, `…_garnishment_policies`,
`statutory_authorities`, `pack_requirements`) against the current Kenyan
statutory payroll regime:

- Income Tax Act (Cap 470) §37 — PAYE
- Tax Procedures Act 2015 §17 (returns), §42 (Agency Notice)
- NSSF Act 2013 (Tier I / Tier II contributions)
- Social Health Insurance Act 2023 + SHIF Regulations 2024 (effective 2024-10-01)
- Affordable Housing Act 2024 §4 (effective 2024-03-19)
- Industrial Training Act (Cap 237) §5B — NITA levy
- HELB Act 1995 §15 — employer loan check-off
- Employment Act 2007 §19 — deduction limits
- Children Act 2022 — maintenance orders
- Co-operative Societies Act §35A — SACCO check-off authorization

## Before

| Artifact                  | Count |
|---------------------------|-------|
| Statutory rules           | 5 (PAYE, NSSF, SHIF, AHL, NITA) |
| Return templates          | 7 (P10, P10A, P10D, AHL, NSSF, SHIF, NITA) |
| Certificate templates     | 2 (P9, P9A) |
| Remittance schedules      | 5 |
| Tax templates             | 26 |
| Account templates         | 113 |
| Authorities               | 4 (KRA, NSSF, SHA, NITA) |
| Garnishment kinds         | **0** ❌ |
| Garnishment policies      | **0** ❌ |
| HELB authority + return   | **missing** ❌ |
| Return submission metadata| **null** on every row ❌ |

## Gaps filled (this change)

1. **HELB authority** seeded (`HIGHER_EDUCATION_LOANS_BOARD`) with portal
   `https://www.helb.co.ke` and employer e-filing endpoint.
2. **HELB Monthly Loan Repayment Schedule** (`HELB_LR`) return template
   added — monthly CSV, due day 15 of the following month, KRA-independent.
3. **Authority portals + e-filing endpoints** populated for KRA (iTax),
   NSSF (e-Service), SHA (Employer Portal), NITA (NITA Portal), HELB.
4. **Return template submission metadata** backfilled on all 7 existing
   returns: `submission_channel`, `submission_format` (csv/pdf options),
   `legal_reference`, `regulation_citation`, `effective_date`,
   `acknowledgement_spec`. The dispatcher (`submit-statutory-return`)
   and the Returns UI now have authority-grade context to render.
5. **Garnishment kinds** seeded (6):
   - `child_maintenance` — always-first, cap-exempt (Children Act 2022)
   - `kra_agency_notice` — always-first, cap-exempt (TPA §42)
   - `court_attachment` — priority 50, cap-counted, max 3 concurrent
   - `helb_recovery` — priority 40, cap-counted, max 1
   - `sacco_checkoff` — priority 60, cap-counted, authorization required
   - `employer_advance` — priority 70, cap-counted
6. **Garnishment policy** `default` with the Employment Act §19(3)
   two-thirds aggregate cap, one-third protected-earnings floor,
   statutory exclusions list (PAYE/SHIF/NSSF/AHL/NITA), and a
   protected-earnings formula token.

## Out of scope / intentionally not changed

- **PAYE bands / personal relief / insurance & mortgage reliefs** —
  already present in `payroll_statutory_rules.parameters` and
  `localization_pack_tax_templates` (26 rows). No drift detected against
  the Finance Act 2023 schedule.
- **P9 / P9A certificate templates** — present, layouts unchanged.
- **Pack requirements** (KRA PIN, NSSF, SHIF, AHL) — already seeded per
  installed org; HELB number is intentionally not marked mandatory because
  it applies only to loaned employees and is enforced by the
  `helb_recovery` garnishment kind's `required_identifiers`.
- **Engine code** — no change. All new behaviour is data inside pack tables.
- **Statutory rule `effective_from` dates** — left at 2024-01-01 to avoid
  a pre-existing bug in `evaluate_payroll_readiness_quiet` (record
  `v_eval` missing `out_status`) that fires from a trigger on
  `payroll_statutory_rules`. Tracked as a separate follow-up.

## Architectural invariants preserved

- No country-named functions, no literal rule codes in engines
  (ADR 0036 §I1/I2).
- All additions live in pack tables under the existing pack id; engines
  continue to dispatch off `computation_method` + `parameters`.
- Return-template `body` continues to be token-resolved by the single
  `_shared/renderTokens.ts` resolver (ADR 0010 §3).

## Verification

```sql
SELECT count(*) FROM localization_pack_return_templates
  WHERE pack_id='a1b2c3d4-e5f6-7890-abcd-ef1234567890';        -- 8 (was 7)
SELECT count(*) FROM localization_pack_garnishment_kinds
  WHERE pack_id='a1b2c3d4-e5f6-7890-abcd-ef1234567890';        -- 6 (was 0)
SELECT count(*) FROM localization_pack_garnishment_policies
  WHERE pack_id='a1b2c3d4-e5f6-7890-abcd-ef1234567890';        -- 1 (was 0)
SELECT count(*) FROM statutory_authorities
  WHERE pack_id='a1b2c3d4-e5f6-7890-abcd-ef1234567890';        -- 5 (was 4)
```

## Publish trail (2026.1.1)

The pack has been formally published as version **`2026.1.1`** via a single
idempotent migration that mirrors what `publish-localization-pack-version`
would emit, closing the ADR-0010 §2 / ADR-0036 §I6 gap from the initial
seeding pass:

| Step | Result |
|---|---|
| `pack_versions` snapshot row | inserted (`status='published'`, `parent_version_id` → `2026.1.0`, `content_hash` = sha256 of grouped child-table snapshot) |
| `localization_packs.version` | bumped `2026.1.0` → `2026.1.1` |
| `pack_upgrade_proposals` fan-out | 1 proposal written (`from_version='2026.1.0'`, `to_version='2026.1.1'`, `status='pending'`) for the single tenant on the previous version |
| Lint gate | skipped (pack rows are already live; deferred until a SQL-side lint wrapper exists) |
| Engine / edge-function code | untouched |

Tenants on `2026.1.0` now have a pending upgrade proposal in their
localization inbox and may accept it through the existing
`/hr/payroll/configuration/localization` flow. New installs pick up
`2026.1.1` automatically via `install_localization_pack_atomic`.

## Returns-tab empty-state copy

`ReturnsTab` and `FilingCalendarPanel` now differentiate two cases via a new
`useHasInstalledLocalizationPack()` probe:

- **No pack installed for this business** → guidance to install a pack
  (templates are pack-driven, no payroll run required).
- **Pack installed but publishes no return templates** → guidance to
  contact the pack publisher.

This corrects a previously ambiguous empty state that conflated the two.
