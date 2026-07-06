
## Independent assessment of what shipped vs the previous plan

I verified every claim against the codebase and the live DB. The previous agent shipped **most of the platform-level plumbing**, but the release itself was never actually published, and three of the seven deliverables were skipped. Anyone hitting "Publish v2026.4.0" today would get an immediate `lint` failure because of the untouched return templates.

**Already landed (verified in code + DB):**

| Deliverable | Where | Verified |
|---|---|---|
| DB trigger `enforce_certificate_template_structure` (section contract + effective_date + authority + regulation_citation) | migration `20260706013020` | ✅ trigger present, gate active |
| `lint-localization-pack` extended with `validateTemplateStructure` for certs *and* returns | `supabase/functions/lint-localization-pack/index.ts` | ✅ hard-fail on any pack row that would fall back |
| `publish-localization-pack-version` calls the linter as a hard gate; extra check for `authority_id` / `legal_reference` / legacy body | `publish-localization-pack-version/index.ts` | ✅ present |
| `generate-tax-certificate` refuses to render with `TEMPLATE_STRUCTURAL_INVALID` (422), legacy `baseSummary` removed | `generate-tax-certificate/index.ts:206-234` | ✅ present |
| P9A rebuilt to KRA 2024 revision (identity headers, columns A–K monthly grid, YTD totals, signature, Sec 37 footnote, KRA authority, `effective_date=2024-07-01`) | migration `20260706013020` + DB row | ✅ 7 sections, matches contract |
| P9 already carries the same contract | DB row | ✅ 7 sections |
| CERT_OF_SERVICE linked to Ministry of Labour, section contract satisfied | DB row | ✅ 6 sections |
| KE pack row bumped to `2026.4.0` | `localization_packs` | ✅ |
| Architecture tests (`certificate-sections-required`, `certificate-template-publishing-gates`, `certificate-canonical-source`, `certificate-legal-metadata-immutable`) | `src/test/architecture/` | ✅ present |
| PackHealthPanel surfaces cert templates missing authority / legal ref / effective date | `PackHealthPanel.tsx` + `useCertificateTemplateHealth` | ✅ (missing metadata + legacy_unvalidated only — the "renders via legacy fallback in last 30 days" check is not implemented) |

**Not done — this is what remains:**

1. **The v2026.4.0 fanout never ran.** `pack_versions` latest is still `2026.3.0`. The migration the previous agent was preparing (`SELECT publish_localization_pack_version_sql(...)`) was never applied, so **no tenant sees the fixed P9A yet**.
2. **All 8 KE return templates would BLOCK the fanout.** Every row in `localization_pack_return_templates` for KE (`P10`, `P10A`, `P10D`, `NSSF_RET`, `SHIF_RET`, `AHL_RET`, `NITA_RET`, `HELB_LR`) has `effective_date = 1900-01-01` and no `body.sections`. The linter added in step 1 will hard-fail publish on every one of them. The publish helper cannot succeed until return templates are refreshed to the same contract.
3. **New KRA columns have no rule-code registry entries.** P9A references `benefits_non_cash`, `value_of_quarters`, `owner_occupier_interest`, `defined_contribution_retirement` in `monthly_breakdown.rule_codes`, but the KE pack only registers `paye / nssf / shif / housing_levy / nita`. The resolver returns zero for any code not present on `payslip_lines`, so columns B, C, E, F will render as `—` forever without an explicit provenance decision.
4. **Payroll & bank-export template surfaces skipped.** Plan §6 called for the same three gates on `localization_pack_payroll_templates` and `localization_pack_bank_export_templates`. Neither the linter nor a DB trigger covers them today.
5. **Publisher-diagnostics health check missing.** The "templates rendering via legacy fallback in last 30 days" signal (reads `payroll_diagnostics` / equivalent for `TEMPLATE_STRUCTURAL_INVALID`) is not surfaced.
6. **No Deno test asserting `generate-tax-certificate` returns 422 on a hand-crafted invalid body.** Only migration-walk tests exist.

## Work to complete

### 1. Refresh the 8 KE return templates (migration)

For every `localization_pack_return_templates` row in the KE pack, set `effective_date` to a real filing-effective date and rebuild `body.sections` to the same contract used for certificates:

- `employer_header` (name, tax_pin / employer_no as appropriate to the authority)
- `filing_period_band` (month + tax year)
- one data section — `totals` for aggregate returns (P10, NSSF, SHIF, AHL, NITA, HELB), `ytd_table` for annual (P10A), or `monthly_breakdown` for `P10D` (employee-detail).
- `signature_block` with the KRA / NSSF / SHA / HELB certification wording
- `statutory_footnote` citing the governing act
- Employee-identity section stays optional for aggregate returns; where the return is per-employee (P10D, HELB monthly loan return), add `employee_header`. Update the DB trigger's `_needed_ident` check to require `employee_header` only when a per-employee data section is present, so aggregate returns are legitimately allowed.

Legal metadata per row: `authority_id`, `legal_reference`, `regulation_citation`, `effective_date >= 2024-07-01` (or the actual gazetted effective date).

### 2. Extend the structural trigger to `return_templates` and `payroll_templates`

Generalise `enforce_certificate_template_structure` into `enforce_pack_template_structure(kind text)` and wire two more triggers:

- `trg_return_template_structure` on `localization_pack_return_templates` — identity `employer_header + signature_block`, data section from `{totals, ytd_table, monthly_breakdown}`, effective_date ≥ 2000-01-01, authority_id required for statutory codes.
- `trg_payroll_template_structure` on `localization_pack_payroll_templates` — payslip contract: `employer_header + employee_header + earnings_table + deductions_table + net_pay_block + signature_block`.
- `trg_bank_export_template_meta` on `localization_pack_bank_export_templates` — enforce `authority_id`, `effective_date`, and a new `spec_reference` text column (bank-file spec version). Body stays free-form (fixed-width / CSV).

Mirror each gate inside `lint-localization-pack` so publish-time errors match trigger errors byte-for-byte.

### 3. Register the four derived KRA rule codes in the KE pack

Add rows to `payroll_statutory_rules` (pack-scope, `business_id IS NULL`) for:

- `benefits_non_cash` — `computation_method='projection'`, sourced from `taxable_benefits_non_cash`
- `value_of_quarters` — `computation_method='projection'`, sourced from `housing_benefit`
- `owner_occupier_interest` — `computation_method='allowance_deduction'`, capped per KRA (KES 300,000/yr)
- `defined_contribution_retirement` — `computation_method='min_of'`, params `[actual_dc_contribution, 0.30 * chargeable_pay, 30000]`

Register the matching tokens in `pack_token_registry` (`employee.ytd.benefits_non_cash`, …) so the linter's token-resolver check passes for P9A.

Extend `_shared/certificateSourceResolver.ts` so any monthly-breakdown rule code that has no row on `payslip_lines` but has a registered `computation_method` gets computed on the fly from its declared inputs, with `provenance='derived'` recorded on the row. This keeps P9A honest for tenants whose payroll engine doesn't yet post those lines.

### 4. Wire the publisher-diagnostics health signal

Verify the diagnostic table name (`payroll_diagnostics` per the plan; if the table is actually `governance_events` or similar, use that). Add `useCertificateRenderFallbackHealth(packId)` that counts rows with `code = 'TEMPLATE_STRUCTURAL_INVALID'` and `template_pack_id = packId` in the last 30 days, and render a third red badge in `PackHealthPanel`.

### 5. Deno test for the render-time refusal

Add `supabase/functions/generate-tax-certificate/render_refusal_test.ts`: constructs an in-memory template `{ code: 'FAKE', body: { sections: [] } }`, mocks the Supabase client to return it, invokes the handler, asserts 422 + `TEMPLATE_STRUCTURAL_INVALID` in the response body.

### 6. Publish v2026.4.0 — the fanout that never ran

New migration that runs *after* (1)–(4) so lint passes:

```sql
SELECT public.publish_localization_pack_version_sql(
  (SELECT id FROM public.localization_packs WHERE country_code = 'KE'),
  '2026.4.0',
  '<same release notes as before + return-template refresh + derived-rule-codes + payroll/bank-export gates>'
);
```

This snapshots `pack_versions`, diffs against `2026.3.0`, writes one `pack_upgrade_proposals` row per installed tenant. No tenant business data is written. Tenants accept via the existing inbox in `/hr/payroll/configuration/localization`.

### 7. Architecture tests — lock the new invariants

- `return-template-sections-required.test.ts` — same walker as the certificate test, over return templates.
- `payroll-template-sections-required.test.ts` — same for payslip templates.
- `bank-export-template-metadata.test.ts` — asserts `spec_reference` + authority + effective_date on every seeded row.
- Extend `certificate-sections-required.test.ts` to assert the KE P9A row's `columns[]` contains all 11 KRA keys A–K by parsing the migration.

## Technical section

- **Ordering** — steps 1-3 must ship in one migration batch so the DB trigger from step 2 sees already-repaired return rows. Otherwise the trigger rejects its own seed refresh.
- **DB trigger factoring** — keep a single `enforce_pack_template_structure(kind)` PL/pgSQL function that switches its required-section set on `kind`, and one BEFORE INSERT/UPDATE trigger per table calling it with the right literal. Avoids drift between the three checks.
- **Aggregate vs per-employee returns** — the trigger's `_needed_ident` set is `{'employer_header','signature_block'}` for return templates by default; when the row's data section is `monthly_breakdown` or the code matches `^(P10D|HELB_LR)`, the trigger additionally requires `employee_header`.
- **Derived rule codes** — resolver reads `payslip_lines` first; on miss, falls back to a computed value with `provenance='derived'` stamped on the row. `no-payslip-lines-in-certificates` ESLint rule already passes because reads still go through `certificateSourceResolver.ts`.
- **Grace period for render refusal** — `pack_versions.strict_render_from` column already listed in the previous plan is not implemented. Not needed if the fanout ships a valid P9A/P9/CERT_OF_SERVICE and every return template in the same version bump, because no in-flight render would resolve to a stub after tenants accept the upgrade. Skip that column; keep the render refusal unconditional. (One less moving part.)
- **Bank-export `spec_reference`** — new column, add via `ALTER TABLE ADD COLUMN spec_reference text` with a follow-up trigger requiring non-null on new inserts. Existing rows get a data-fix in the same migration.

## Out of scope

- UI polish on `CertificateTemplateEditor` / `ReturnTemplateEditor` beyond the palette entries needed to author the four new derived rule codes.
- Non-KE pack refreshes (UG / TZ / NG). Those get their own plans once the platform gates are enforced everywhere.
- Any tenant-side data patch. Tenants pick up the fixes via `pack_upgrade_proposals` on their own timeline.
