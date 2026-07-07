## Ghana Localization Pack — Remaining Publication Plan

**State assumed done** (per handoff): all engine gap-closures (#1–#4), pack metadata enriched, `is_active=true`, `tokens_inherit_platform=true`, and the four `statutory_authorities` rows (GRA, SSNIT, NPRA, SLTF) exist. I will verify with a read-only `supabase--read_query` sweep before writing anything; if a row is already present with equivalent content I skip it, if it drifts from the spec below I ask before overwriting.

Everything below is authored under `pack_id = 8de30937-dab1-4a75-b6e6-6f4a25622ca2`, `country_code = 'GH'`. Nothing here backfills any installed tenant — publication is via a fresh `pack_versions` snapshot at the end, and existing tenants (if any) receive an upgrade proposal, never a silent overwrite.

### Artifact 2 — Ghana token registry additions
Insert into `pack_token_registry` the Ghana-scoped employee inputs the rules below reference (all `source='employee'`, `data_type='number'` unless noted): `tier3_voluntary_employee`, `tier3_voluntary_employer`, `mortgage_interest_owner_occupied`, `life_insurance_premium`, `child_education_relief_count` (int), `aged_dependant_relief_count` (int), `disability_certified` (boolean-as-number), `qualifying_junior_employee` (boolean-as-number), `residency_status` (string: `resident`/`non_resident`), `sltf_monthly_deduction`. Each row carries a `description` and `sample_value` so `SchemaForm` renders sensible defaults.

### Artifact 3 — Payroll statutory rules (`payroll_statutory_rules`)
Authored one row per rule with `computation_method` + validated `parameters` (never a literal rule_code branch). Order matters for pre-tax deductibility:

1. **SSNIT Tier 1 employee** — `percentage`, 5.5% of basic, ceiling GHS 61,000/month, pre-tax deductible.
2. **SSNIT Tier 1 employer** — `percentage`, 13% of basic, ceiling GHS 61,000/month, employer contribution (Tier 2 5% carve documented via `sub_allocation` metadata, not a second engine rule — remittance schedule splits the payment).
3. **Tier 2 mandatory** — informational row that references rule #2's carve; no separate employee cost.
4. **Tier 3 voluntary employee** — `percentage` on `tier3_voluntary_employee`, pre-tax deductible up to the 16.5%-of-basic combined cap (parameter `combined_relief_cap_pct = 0.165`, flagged `[Verify Act 896 s.112]` in `data_source_note`).
5. **SLTF** — `flat` monthly amount from `sltf_monthly_deduction`, post-tax.
6. **PAYE resident** — `bracket_progressive` monthly bands derived from the annual GRA First Schedule (0/5/10/17.5/25/30/35, top band > 605,000 annual, flagged `[Verify vs PwC 600,000]`). Reads pre-tax deductions from Tier 1 + Tier 3 through the payroll-template deductibility mechanism (not hard-coded).
7. **PAYE non-resident** — `flat` 25%, `residency='non_resident'`, no reliefs.
8. **Bonus tax** — `bonus_windfall`, 5% up to 15% of annual basic, excess published to `ctx.inputs.bonus_rolled_to_paye`.
9. **Overtime QJE** — `overtime_concessional`, `qualifying_junior_only=true`, annual qualifying-income cap GHS 18,000, 5% up to 50% of monthly basic then 10%, excess published to `ctx.inputs.overtime_rolled_to_paye`.

Each row: `effective_from='2025-01-01'`, `data_source_note` citing the compliance brief, `legacy_unvalidated=false` (validator must accept).

### Artifact 4 — Account roles + account templates + GL mappings
- `pack_account_roles`: `GH_PAYE_PAYABLE`, `GH_SSNIT_TIER1_PAYABLE`, `GH_SSNIT_TIER2_PAYABLE`, `GH_TIER3_PAYABLE`, `GH_SLTF_PAYABLE`, `GH_SALARIES_EXPENSE`, `GH_EMPLOYER_SSNIT_EXPENSE`, `GH_NET_PAY_CLEARING`.
- `localization_pack_account_templates`: one row per role above with a Ghana-conventional account number (2xxx liabilities, 5xxx/6xxx expenses, 1xxx clearing) and normal balance.
- Each `payroll_statutory_rules` row's `gl_mapping` (or the equivalent pack-level rule→role join) points to the correct role so `payroll_gl_readiness` reports 100 %.

### Artifact 5 — Payroll templates & work-entry types
- `localization_pack_payroll_templates`: one payslip template ordering earnings → pre-tax deductions (Tier 1 EE, Tier 3 EE) → PAYE → post-tax (SLTF, garnishments) → net; explicitly marks Tier 1 EE and Tier 3 EE `reduces_taxable_income=true` (the `pack_income_tax_deductibility_test` SQL test will assert this).
- `localization_pack_work_entry_type_templates`: `REGULAR`, `OVERTIME_QJE`, `BONUS`, `LEAVE_PAID`, `LEAVE_UNPAID`, `REDUNDANCY_EXEMPT` (flagged tax-exempt), `PILON`, `GRATUITY`.

### Artifact 6 — Remittance schedules
Four rows in `localization_pack_remittance_schedules`, all using the new `roll_forward_weekend_holiday=true`:
| Authority | Rule set | Due | Grace |
|---|---|---|---|
| GRA | PAYE | 15th of following month | 0 |
| SSNIT | Tier 1 (5.5 % + 8 %) | 14th of following month | 0 |
| NPRA | Tier 2 (5 % carve, paid to trustee) | 14th of following month | 0 |
| SLTF | SLTF deductions | 15th of following month | 0 |

### Artifact 7 — Return templates
- **PAYE monthly return** (`localization_pack_return_templates`) — GRA layout, tokens for employer TIN, period, per-employee gross/allowable-deductions/chargeable/PAYE, totals. Bound to `GH_GRA`.
- **SSNIT monthly contribution schedule** — SSNIT layout, per-employee SSNIT number, basic, 5.5 %, 13 %, total. Bound to `GH_SSNIT`.
- **Annual employer schedule (Form of Return of Income)** — due 30 April.

### Artifact 8 — Certificate templates
- **Annual employee tax certificate** — one page, one employee, one tax year; tokens for name, TIN, SSNIT no., total gross, allowable deductions, chargeable income, PAYE paid, employer name/TIN. Passes ADR-0060 completeness lint.

### Artifact 9 — Bank export templates
- Ghana ACH / GhIPSS-compatible CSV for staff net pay and a second layout for statutory bulk payments (GRA / SSNIT / SLTF). Currency `GHS`.

### Artifact 10 — Garnishment kinds & policies
- `COURT_ORDER`, `SLTF_NOTICE`, `TAX_ARREARS_NOTICE`. Policies: SLTF pre-tax? no — post-tax per current SLTF practice.

### Artifact 11 — Pack requirements
Employer-level: TIN, SSNIT employer number, NPRA-licensed Tier 2 trustee identifier.
Employee-level: TIN, SSNIT number, Ghana Card PIN, residency status, date of birth (for QJE age check).

### Artifact 12 — Health, lint, publish
1. Run `PackHealthPanel` query — expect zero legacy_unvalidated, zero missing schedule, zero unmapped role.
2. Invoke `validate-localization-payload` for every rule and template.
3. Invoke `lint-localization-pack` — must return 0 blocking findings; `[Verify]` items land as warnings with `data_source_note`.
4. Invoke `publish-localization-pack-version` with `version = '1.0.0'` — snapshots into `pack_versions`, emits `pack.published` to outbox, refreshes filing calendar. No installed tenants today, so no upgrade proposals fan out; this is a clean maiden version.

### Platform improvements shipped alongside (UX-wins from the audit, kept small)
- **U-#10** Sample-employee preview button in `CertificateTemplateEditor` and `ReturnTemplateEditor` — one canned Ghana fixture, drives existing `PreviewPanel`.
- **U-#11** GL coverage strip inside `AccountTemplatesEditor` listing unmapped `pack_account_roles`.
- **U-#12** Four extra `PackHealthPanel` checks: (a) authority without schedule, (b) schedule without return template, (c) return template with no filing-calendar projection, (d) rule without GL mapping.

Deferred to ADR 0056 P2 (unchanged from the earlier audit): semantic diff (#6), dependency graph (#7), dry-run simulator (#8), 4-eyes review (#9).

### Order of execution
1. Read-only verification sweep (confirm handoff state).
2. Artifacts 2 → 11 via `supabase--insert` (data) with `ON CONFLICT DO NOTHING`, one artifact per call so each is reviewable.
3. Platform UX-wins U-#10/11/12 via frontend edits (no schema).
4. Health → lint → publish via `stack_modern--invoke-server-function` calls in-app; report the resulting `pack_versions` row id.

### What I need from you
- Confirm plan; on approval I switch to build mode and execute in the order above, pausing after each artifact insert so you see what landed before the next one.
- Two `[Verify]` items worth flagging now so we don't block on them: PAYE top band threshold (605k vs 600k annual) and Tier 3 combined cap wording. I'll author with the compliance-brief numbers and mark both `data_source_note = '[Verify: GRA First Schedule 2025]'` — legal review can amend before any tenant activates.
