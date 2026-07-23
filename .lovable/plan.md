
# Annual Earnings Statement — Enterprise Architecture Audit & Redesign

## 1. What the audit found

The uploaded PDF (`Annual_earnings_statemennt.pdf`) and the current template/generator surface reveal three separate classes of defect: **stale content**, **incomplete DTO**, and **missing architectural extensibility**. The PDF is a symptom; the architecture is the target.

### 1.1 Observed defects in the rendered artifact

| Section | Observed | Root cause (verified) |
|---|---|---|
| Header | "Joshua Holdings" only, no employer address, no legal entity, no employer identifiers | `enginePayload.employer` is built from `getOrganizationBranding` (name/address/tax_pin/tax_office/phone/email). Address is empty in the org record; there is no `legal_name`, no `registered_address`, no dynamic statutory identifiers block. |
| Employee strip | Missing position, employment period, employment status, statutory identifiers | Template binds only `full_name / employee_number / department`. Department empty because `payload.employee.department` upstream isn't hydrated for this record. |
| Monthly matrix columns | PDF shows `Gross / Statutory Deductions / Other Deductions / Reliefs / Net` | PDF is from a **stale template body** (pre-migration `20260715112244`). Current registry body has `Gross / Benefits / Statutory Deductions / Net`. Neither set is architecturally sufficient — see §2. |
| Monthly matrix data | 11 months show `0.00`, only April populated | Correct — only one posted run exists. Not a defect. |
| Year-to-Date Summary | Labels present, **all values blank** | Template binds `totals.gross_pay / totals.deductions / totals.net_pay`. `resolveCertificateYtd` computes these correctly. The blank values are almost certainly a **binding-resolution bug** in the v3 HTML compiler for the `key_value → binding.path` pattern with nested paths when `format:"currency"` receives a zero-ish value — needs a direct compiler test, not a template change. |
| Signature strip | Static "Authorised Signatory / Payroll Office" | Not bound to actual approver / issuer / issuance date. |
| Localization sections | None | Template has zero extension points. A pack cannot inject a P9/P60/IRP5 addendum without cloning the template. |

### 1.2 Architectural defects (the actual assignment)

1. **Reporting DTO is under-specified.** The single `totals` object mixes YTD aggregates, rule-code aggregates, and (when v3 pivot runs) template-specific keys (`chargeable_pay`, `paye`). There is no versioned, typed `AnnualEarningsStatementDTO`.
2. **No canonical `earnings.months` shape.** The matrix builder writes whatever `derived_columns` produce; there is no contract that guarantees `{gross, benefits, statutory_ee, statutory_er, other_deductions, reliefs, taxable, net}` on every month, in every pack.
3. **Employer/employee identity is flattened to strings.** `organization_statutory_identifiers` and `employee_statutory_identifiers` exist in the DB but are not projected into the DTO for this template — only the country-specific `generate-tax-certificate` path uses them, and only for pack-specific fields.
4. **No employer-contribution / benefit / adjustment / reversal / leave-payout channels** on the DTO, even though `payroll_employee_ytd_rollup` returns `employer_amount` and `taxable_amount` per rule. The template cannot bind what the DTO doesn't expose.
5. **No localization extension point.** ADR-0062 states packs "publish, they do not hardcode", but the Annual Earnings Statement template has no `slots` / `extension_regions`. A Kenya pack cannot append a P9-formatted appendix without owning a separate template.
6. **No provenance band on the artifact.** `provenance` is computed by the resolver and stored on the certificate row, but never rendered onto the document (serial + generated_at only). Auditors need `run_ids`, `payslip_high_water_mark`, `source_hash`.
7. **No determinism seal.** Two regenerations of the same fiscal year should be byte-identical when upstream payroll is unchanged. Today the DTO embeds `generated_at` inside the compiled HTML with no separation between "content hash" and "issuance hash", so `stale=true` cannot be proven from the artifact alone.
8. **Renderer is coupled to certificate engine.** Any generic "annual statement" caller has to go through `generate-tax-certificate`, which is scoped to statutory certificate issuance. There is no `generate-annual-earnings-statement` entry point, no self-service `/me/annual-earnings` route.

## 2. Target architecture

```text
payroll_runs (immutable)
  └─ payslips (immutable, allowlisted mutations)
       └─ payslip_lines (rule_code, category, employee/employer/taxable)
            └─ payroll_employee_ytd_rollup (RPC, canonical)
                 └─ resolveAnnualEarnings(org, business, employee, fiscal_year)   ← NEW single writer
                      └─ AnnualEarningsStatementDTO v1                            ← NEW typed contract
                           ├─ base template: ANNUAL_EARNINGS_STATEMENT v2
                           │    (country-neutral, slot-aware)
                           └─ pack extensions:
                                 KE.P9_APPENDIX / GB.P60_APPENDIX / ZA.IRP5_APPENDIX / GH.SSNIT_APPENDIX
```

### 2.1 New DTO (`AnnualEarningsStatementDTO v1`)

Sections, all optional except `employer`, `employee`, `period`, `months`, `ytd`:

- `employer`: `{ name, legal_name, registered_address, contact, statutory_identifiers[] }`
- `employee`: `{ full_name, employee_number, department, position, employment_status, employment_period{from,to}, statutory_identifiers[] }`
- `period`: `{ fiscal_year, from, to, label, currency }`
- `months[12]`: `{ month, gross, benefits, taxable, statutory_employee, statutory_employer, other_deductions, reliefs, adjustments, reversals, leave_payouts, bonuses, net }`
- `ytd`: same shape as `months` row, plus `employer_contributions_total`, `pension_total`, `final_settlement`
- `breakdown`: `{ earnings[], benefits[], statutory_ee[], statutory_er[], other_deductions[], reliefs[] }` — per-rule rows sourced from `payroll_employee_ytd_rollup`
- `provenance`: `{ run_ids[], payslip_ids[], payroll_high_water_mark, dto_version, content_hash }`
- `extensions`: `{ [pack_code]: unknown }` — pack-populated

### 2.2 Template contract v2

- Add `extension_regions: ["after_ytd", "after_signature", "appendix"]` to the base template body.
- Renderer discovers pack contributions via `payroll_certificate_template_extensions` (new registry table) keyed by `(base_template_code, pack_code)`.
- Business math stays out of the template — templates only bind `dto.*` paths and select which extension regions render.

### 2.3 New writer + route

- `resolveAnnualEarnings(...)` in `supabase/functions/_shared/annualEarningsResolver.ts` — the only allowed writer of `AnnualEarningsStatementDTO`. Delegates YTD numbers to `resolveCertificateYtd` (no duplicate arithmetic).
- New edge function `generate-annual-earnings-statement` — thin dispatcher that loads the base template, resolves the DTO, merges pack extensions, and invokes the existing v3 HTML compiler. Reuses `document_artifacts` storage + `generateReportPdf`-style download surface.
- New ESS route `/me/annual-earnings` — employee self-download of their own statement, with the same `auth.uid()`-scoped self-service bypass used for payslips.

### 2.4 Determinism & provenance

- DTO builder computes `content_hash = sha256(canonical_json(dto without generated_at))`.
- Artifact metadata columns: `content_hash`, `dto_version`, `payroll_high_water_mark`, `regenerated_from`.
- Regeneration with unchanged inputs produces identical `content_hash`; `stale=true` flips only when the high-water mark advances (already wired via `payroll_mark_stale_certificates`).
- The rendered document footer prints `Serial · Generated · Content-hash (short)`.

### 2.5 Localization extension mechanism

Packs contribute optional appendix bodies via a new migration adding rows to `payroll_certificate_template_extensions` for their country. First cut: seed a KE `P9_APPENDIX` extension that renders Cols A–O of the KRA P9 grid using the same `dto.months` data — no new arithmetic, no country tokens in shared code (enforced by the existing arch test `annual-earnings-canonical-binding.test.ts`).

## 3. Deliverables (this plan, no deferral)

1. **DTO + resolver**
   - Add `AnnualEarningsStatementDTO` types in `supabase/functions/_shared/annualEarningsTypes.ts`.
   - Add `resolveAnnualEarnings` in `supabase/functions/_shared/annualEarningsResolver.ts`; delegate YTD to `resolveCertificateYtd`; project identifiers from `organization_statutory_identifiers` + `employee_statutory_identifiers`; pivot monthly rows via `payroll_employee_monthly_breakdown` categorised into the DTO shape.
   - Unit test: canonical categories map deterministically; `content_hash` stable across two runs with identical inputs.
2. **Template v2 (country-neutral)**
   - Migration that updates `ANNUAL_EARNINGS_STATEMENT` body to bind the richer DTO paths (employer identifiers row, employment period, monthly matrix with 8 canonical columns, YTD block with employer contributions/pension/adjustments, provenance footer, `extension_regions`).
   - Fixes the "YTD Summary blank" symptom by binding `dto.ytd.*` through the resolver and adding a compiler regression test for nested `key_value → binding.path.with.currency-format` on zero-valued and populated cases.
3. **Edge function + registry table**
   - Migration: `payroll_certificate_template_extensions(base_template_code, pack_code, region, body jsonb, version int, ...)` with grants + RLS.
   - New edge function `generate-annual-earnings-statement` (dispatcher only, reuses v3 compiler).
   - Extends `document_artifacts` writer to persist `content_hash`, `dto_version`, `payroll_high_water_mark`.
4. **KE P9 appendix pack row**
   - Migration inserting the P9 appendix as a `payroll_certificate_template_extensions` row (pack_code=`ke`, region=`appendix`). Uses only `dto.months` + `dto.breakdown` — no re-summing.
5. **ESS surface**
   - `/me/annual-earnings` page with year selector and download button; self-service bypass mirrors `/me/payslips`.
6. **Architecture guards**
   - Extend `src/test/architecture/annual-earnings-canonical-binding.test.ts` to assert: (a) base template body contains zero country tokens, (b) resolver is the only caller of `payroll_employee_ytd_rollup` and `payroll_employee_monthly_breakdown` for this template, (c) extension bodies never import from shared code paths that touch `payslip_lines` directly.
7. **Docs**
   - New ADR-0063 "Annual Earnings Statement — canonical DTO + pack extension regions" documenting invariants and the extension registry.
   - Update `docs/manuals/hr-payroll/10-payroll-documents.md` with the new function, DTO, ESS route, and hash-based determinism guarantee.

## 4. Invariants (non-negotiable)

- Base template stays country-agnostic. Zero country tokens allowed in `src/` or in the base template body.
- All numbers come from `payroll_employee_ytd_rollup` / `payroll_employee_monthly_breakdown`. Templates never do arithmetic beyond declarative `sum`/`sub` on already-projected columns.
- One resolver, one writer. No caller may reconstruct the DTO inline.
- Every generation writes to `document_artifacts` with `content_hash` + `payroll_high_water_mark`.
- Pack extensions are additive and optional; uninstalling a pack retracts its appendix automatically.

## 5. Out of scope (explicit, not deferred)

None. Every milestone above ships in this plan.
