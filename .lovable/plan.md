
## Kenya Localization Pack (v2026.4.0) — Deep Audit

### 1. What is currently shipped

Pack `a1b2c3d4…7890`, published/stable. Inventory:

| Artifact | Count | Notes |
|---|---:|---|
| Chart of accounts | 104 | IFRS-style, KES-denominated, VAT/WHT/M-Pesa accounts present |
| Tax templates | 26 | VAT 16/8/0/Exempt, 12 WHT variants, Excise (financial), CIT 30%, TOT 3%, CGT 15%, SEP 30% |
| Payroll rule templates | 5 | PAYE, NSSF, SHIF, AHL, NITA |
| Statutory authorities | 7 | KRA, NSSF, SHA, NITA, HELB, MoL, (duplicate KRA row) |
| Remittance schedules | 5 | PAYE, NSSF, SHIF, AHL monthly; NITA annual |
| Return templates | 8 | P10, P10A, P10D, NSSF, SHIF, AHL, NITA, HELB byproducts |
| Certificate templates | 3 | P9, P9A, Certificate of Service |
| Bank-export templates | 1 | Pesalink CSV |
| Garnishment kinds | 6 | Child maintenance, KRA agency, court, HELB, SACCO, advance |
| Garnishment policies | 1 | Aggregate cap policy |
| Account roles | 2 | Minimal |
| Tokens | 5 | Very small — Ghana pack has 21 |
| **Work entry types** | **0** | **Critical gap** |

### 2. Odoo `l10n_ke*` + KRA/Employment-Act parity baseline

Odoo's Kenyan localization (l10n_ke, l10n_ke_hr_payroll, l10n_ke_edi_oscu, l10n_ke_reports) plus a fully-fiscalized KE stack ships:

1. IFRS CoA (present).
2. Fiscal positions: Resident, Non-Resident, EPZ/SEZ, Export, Reverse-charge imported services, Withholding-VAT customer/vendor (missing).
3. Tax report mappings — VAT3 boxes, WHT return schedules (P11), CGT return, TOT return, CIT (IT2C), Excise, DST/SEP, Import VAT (missing).
4. eTIMS OSCU signing on every tax invoice (CU serial, receipt sig, QR) — code exists in tree, not wired to pack.
5. KRA PIN validation regex (`^[AP]\d{9}[A-Z]$`) on contacts/orgs.
6. Withholding VAT 6% (appointed agents) — separate from income WHT.
7. Payroll: PAYE + NSSF Tier I/II + SHIF + AHL + NITA (all present), **plus** Personal Relief (KES 2,400/mo), Insurance Relief (15% cap 5,000), Mortgage Interest Relief (cap 25,000/mo), Pension Contribution Relief (cap 20,000/mo or 30% of pensionable), Disability Exemption (first 150,000/mo), Home-Ownership Savings Plan (sunset marker), Owner-occupied interest deduction, Fringe Benefit Tax on cheap staff loans, Car benefit, Housing benefit, Per-diem tax-free 2,000/day, Overtime rules, Gratuity/Service pay, Employer NSSF match, HELB recovery (currently only a garnishment kind — needs a payroll rule for statutory ordering).
8. Employer-side: WIBA insurance, Standards Levy 0.2% (KEBS, manufacturers), Tourism Levy 2% (hospitality), County single-business-permit hook.
9. Public holidays (KE) seeded from pack.
10. Work entry types (normal, OT 1.5×/2×, sick, annual, maternity, paternity, unpaid, public holiday, study, compassionate).
11. Employment-Act leave defaults (21 annual, 14 sick, 90 maternity, 14 paternity).
12. Bank formats: Pesalink (present) + KBA EFT batch + RTGS/SWIFT MT103 + M-Pesa B2C bulk + M-Pesa Paybill remittance file.
13. NHIF legacy sunset marker (Oct 2024 → SHIF), NSSF Act 2013 Tier I/II split explicit.
14. Fringe benefit tax quarterly market rate (CBR-linked).
15. Statutory identifiers: KRA PIN, NSSF, SHIF, HELB, NITA, WIBA — with format validators.
16. Payslip legal footer + P9 continuous accrual.
17. RBA (Retirement Benefits Authority) occupational pension mapping.

### 3. Verdict

**Not green-light.** Chart of accounts, VAT/WHT catalog, and monthly-return byproducts are solid — matches or exceeds Odoo on those. But payroll depth, work-entry types, tax-report field mappings, fiscal positions, statutory reliefs, and non-payroll return templates are shallow compared to a production KE stack. Below is the gap remediation plan.

### 4. Gap list, prioritized

**P0 — blocks correct payroll math today**
- G1. Personal Relief (KES 2,400/mo) as a payroll rule that reduces PAYE — currently implicit in bracket table or missing.
- G2. Insurance Relief (15% of premiums, cap 5,000/mo).
- G3. Mortgage Interest Relief (cap 25,000/mo).
- G4. Pension Contribution Relief (min of contribution, 30% pensionable, or 30,000/mo — 2024 Act).
- G5. Disability Tax Exemption (first 150,000/mo, KRA cert required).
- G6. Employer NSSF matching contribution rule (Tier I 6% + Tier II 6%, currently only employee side).
- G7. Employer AHL matching (1.5%) — verify separated from employee 1.5%.
- G8. HELB payroll rule (statutory, not just garnishment) so ordering vs PAYE is deterministic.
- G9. Seed the 10 work entry types (0 today) inheriting to `payroll_work_entry_types`.

**P1 — blocks statutory filing coverage**
- G10. VAT3 monthly return template + box mapping (KRA online VAT3 CSV).
- G11. Withholding VAT (6%) tax templates + reverse-charge fiscal position.
- G12. WHT return template (monthly WHT eSlip payload).
- G13. CIT annual return (IT2C) template.
- G14. Turnover Tax monthly return template.
- G15. CGT return template (per-transaction, 5-working-day deadline).
- G16. DST/SEP return template.
- G17. Excise Duty return + missing excise rates (airtime/data 15%, alcohol/tobacco tiers, sugar tax, plastics).
- G18. Fiscal positions: Resident / Non-Resident / EPZ / SEZ / Export / Reverse-charge / WHT-VAT-appointed.

**P2 — completeness / parity**
- G19. eTIMS OSCU invoice-signature spec attached to bank-export/document templates so tax invoices print CU serial + QR.
- G20. KRA PIN + NSSF/SHIF/HELB identifier regex + validator on `organization_statutory_identifiers` and contacts.
- G21. Public-holidays seed for KE (10 dated + 2 Islamic movable).
- G22. Employment-Act leave-type defaults (21/14/90/14) — seed via existing `leave_types` platform templates.
- G23. Bank formats: KBA EFT batch, M-Pesa B2C bulk, RTGS MT103.
- G24. Fringe Benefit Tax quarterly market rate rule (references CBR).
- G25. Car benefit + housing benefit computations as rules.
- G26. Per-diem tax-free threshold constant (2,000/day) token.
- G27. Standards Levy 0.2% (manufacturers only, gated by sector).
- G28. Tourism Levy 2% (hospitality only).
- G29. WIBA employer insurance expense mapping (informational).
- G30. NHIF legacy rule row marked `sunset_date=2024-10-01`, superseded_by = SHIF — audit trail.
- G31. Expand pack_token_registry: currently 5 tokens; needs ~25 (personal_relief_amount, insurance_relief_cap, mortgage_interest_cap, pension_relief_cap, disability_exempt_amount, per_diem_cap, nssf_tier1_ceiling, nssf_tier2_ceiling, ahl_rate, shif_rate, nita_flat, helb_min_repayment, cbr_rate, etc.).
- G32. Payslip legal footer (Employment Act 2007 §20 disclosure line).

### 5. Delivery batches (each = one migration + verification query)

Because we're following the same platform contracts that Ghana used, each batch keeps the engine country-agnostic (dispatch on `computation_method` + parameters; no new literal rule-code branches).

```text
Batch KE-1  P0 payroll depth  →  G1-G8 (8 new rules + parameters)
Batch KE-2  Work entry types  →  G9 (10 rows)
Batch KE-3  Fiscal positions + WHT-VAT + missing excise  →  G11, G17, G18
Batch KE-4  Returns + tax-report mappings  →  G10, G12-G16
Batch KE-5  Identifiers, holidays, leave defaults  →  G20, G21, G22
Batch KE-6  eTIMS OSCU wiring + payslip footer  →  G19, G32
Batch KE-7  Additional bank formats  →  G23
Batch KE-8  Sector-gated levies + FBT + benefits + tokens  →  G24-G31
Batch KE-9  Publish v2026.5.0 snapshot to pack_versions,
            mark v2026.4.0 as superseded, flip status
```

Each batch ends with: (a) sample compute-payroll dry-run against a synthetic KE employee to compare PAYE against KRA's public calculator, (b) `pack_income_tax_deductibility_test.sql` re-run, (c) `no_country_named_functions_test.sql` re-run.

### 6. Verification checkpoints (must pass before Batch KE-9 publish)

1. Payslip for gross KES 250,000 with 20k pension, 5k insurance premium, mortgage 30k/mo, matches KRA iTax PAYE calculator to the shilling.
2. All P0 rules resolve via `pre_tax_deductions[]` or engine input registry — deductibility test green.
3. Every new template has `authority_id`, `legal_reference`, `regulation_citation`, and `effective_date`.
4. `computation_method` on every new rule is already in the extended CHECK constraint.
5. Sunset marker on NHIF row present; SHIF row marked `effective_date=2024-10-01`.
6. Pesalink + at least one additional bank format (EFT) exports round-trip.

### 7. What I need from you before starting Batch KE-1

- Confirm scope: full 9-batch remediation, or stop after P0+P1 (batches KE-1 through KE-4) and defer the rest.
- Legal verify sourcing: I'll cite Finance Act 2023/2024, KRA public rulings, NSSF Act 2013, SHIF Act 2023, AHL Act 2023 — flag anywhere you want me to withhold a rate and mark `[Verify]` in `data_source_note` instead.
- Version bump target: propose `v2026.5.0` immutable snapshot, keeping `v2026.4.0` byte-identical for tenants already on it (built-ins-win-on-collision guarantee).

Approve this plan (or narrow the scope) and I'll open Batch KE-1 as the first migration.
