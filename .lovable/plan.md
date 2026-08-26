# HELB / Custom Deduction → Remittance → Return Investigation

Read-only investigation. No code, schema, data, or template was changed.

---

## 1. Executive verdict

**The HELB return is empty because the tenant's HELB custom deduction was created without a pack rule code, so its payslip line was emitted under `custom_helb`, while the pack's HELB return template filters on `rule_codes: ["helb"]`. The two never meet.**

This is **primarily a configuration + UI-discoverability defect, not an architectural one**. The architecture is present, coherent, and already proven end-to-end by the NSSF Voluntary (Type-105) case, which is configured correctly and does bind to its return column.

Three independent, additive causes were confirmed:

| # | Cause | Severity |
|---|---|---|
| 1 | `custom_deduction_types.payroll_rule_code IS NULL` for HELB → line emitted as `custom_helb`, not `helb` | **Primary — fully explains the empty return** |
| 2 | Neither payroll run has been posted (`payroll_runs.posted_at IS NULL`); `payroll_liabilities` is empty | Explains the missing liability, independent of #1 |
| 3 | `post-payroll-gl` never creates a `payroll_liabilities` row for **any** custom deduction, even a correctly-coded one | **Genuine architectural gap** — would still bite after #1 and #2 are fixed |

---

## 2. What the system currently does

```text
custom_deduction_types                     (tenant-authored)
  .code, .payroll_rule_code, .scheme_component_id, .gl_liability_account_id
        |
employee_custom_deductions                 (assignment: dates, caps, min-net floor, approval)
        |
compute-payroll  ──►  emittedCode = payroll_rule_code ?? `custom_${code}`
        |
payslip_lines
  .rule_code = emittedCode      .rule_type = 'custom_deduction'
  .scheme_component_id          .source = {assignment_id, deduction_type_id, gl accounts}
        |
        ├──► post-payroll-gl  "Slice 2"  ──► journal_entry_lines
        |         CR custom_deduction_types.gl_liability_account_id
        |         (contact_id = null, no rule/type identifier on the JE line)
        |
        ├──► post-payroll-gl  "R4"       ──► payroll_liabilities
        |         ONLY iterates deductionMap (statutory rule_codes) + garnishments.
        |         Custom deductions `continue` out at index.ts:441 — never reach R4.
        |
        └──► generate-statutory-return
                  reads localization_pack_return_templates.body.filters.rule_codes
                  + statutory_reporting_bindings
                  sums payslip_lines WHERE rule_code IN (...)
```

Evidence:
- `supabase/functions/compute-payroll/index.ts:4202` — `const emittedCode = cd.payroll_rule_code ?? \`custom_${cd.code}\`;`
- `supabase/functions/post-payroll-gl/index.ts:425-441` — custom-deduction lines diverted into `customDedMap` and `continue`, so they never enter `deductionMap`.
- `supabase/functions/post-payroll-gl/index.ts:1120-1301` — R4 liability writer iterates only `deductionMap` + `garnishmentMap`.
- `supabase/functions/_shared/returnSourceResolver.ts` — return column sources resolve to sums over `payslip_lines` keyed by `rule_code` (`sum_rule.<code>.<side>`, `sum_employee_amount`).

**Live data confirming the failure:**

| Record | Value |
|---|---|
| `custom_deduction_types` where code='helb' | `payroll_rule_code = NULL`, `scheme_component_id = NULL` |
| `custom_deduction_types` where code='nssf_voluntary' | `payroll_rule_code = 'nssf_voluntary'`, `scheme_component_id = e3f400b7…` |
| `payslip_lines` for the HELB deduction | `rule_code = 'custom_helb'`, `scheme_component_id = NULL`, amount 1000.00 |
| `localization_pack_return_templates` HELB_LR | `filters.rule_codes = ["helb"]` |
| `statutory_scheme_components` | `helb_employee` exists: `rule_code='helb'`, `gl_liability_role='helb_payable'` |
| `statutory_authorities` | `HIGHER_EDUCATION_LOANS_BOARD` exists (KE) |
| `payroll_liabilities` | **0 rows** |
| `payroll_runs` | PAY-0086, PAY-0088 both `status='approved'`, `posted_at = NULL` |
| `payroll_statutory_rules` | paye, nssf, shif, housing_levy, nita — **no `helb`** |
| `employee_statutory_identifiers` | tax_pin, shif_number, nssf_number — **no `helb_number`** |

---

## 3. What is working correctly (do not change)

- **Custom deduction calculation** — flat/percentage methods, cumulative cap, `cumulative_recovered` tracking, min-net floor, approval workflow, auto-completion, append-only `employee_custom_deduction_events` audit trail.
- **Identity preservation through payroll.** Contrary to the "information is lost" hypothesis, `payslip_lines` retains **four** independent handles on the source: `rule_type='custom_deduction'`, `source->>'deduction_type_id'`, `source->>'assignment_id'`, and `scheme_component_id`. Nothing is flattened into a generic "other deduction".
- **The three-tier statutory model already exists and is correct**: `statutory_authorities → statutory_schemes → statutory_scheme_components → statutory_reporting_bindings → return template column`. This matches the industry-standard layering.
- **`payroll_rule_code` guardrails** — CHECK constraint `^[a-z][a-z0-9_]*$` and `NOT LIKE 'custom\_%'`, unique per business, plus reserved-code guardrail trigger blocking `paye`/`nssf`/`shif`/etc. as custom codes.
- **NSSF Voluntary is the working reference implementation** — pack-published voluntary component, bound via both `payroll_rule_code` and `scheme_component_id`, surfacing on `NSSF_RET` column `sum_rule.nssf_voluntary.employee`. It proves the intended path works.
- **GL readiness gate** — `payroll_readiness_eval_rule` blocks a run when an active custom deduction type lacks its liability account.
- **Pack lint logic** (`localization-pack/ops/lint.ts`) already enforces that voluntary/employer/top-up scheme components declare a `statutory_reporting_bindings` row or an explicit `parameters.reports_to='none'` opt-out.
- Mandatory statutory deductions, garnishments, loan repayment and advance recovery posting paths.

---

## 4. Where the HELB information goes

```text
HELB custom deduction type
  code = 'helb'
  payroll_rule_code = NULL          ◄── identity binding NEVER SET
  scheme_component_id = NULL        ◄── identity binding NEVER SET
  gl_liability_account_id = 05a62ad6…
        │
        ▼
Assignment → compute-payroll → payslip_lines
  rule_code = 'custom_helb'         ◄── DIVERGES from pack expectation 'helb'
  source.deduction_type_id = b2926bb2…   (identity still present here)
        │
        ├─► GL: never posted (run not posted). Even if posted, the JE line
        │   carries only account_id + a free-text description — no rule/type ref.
        │
        ├─► payroll_liabilities: NEVER, by design of R4. Custom deductions are
        │   structurally excluded from the remittance-liability writer.
        │
        └─► HELB_LR return: SELECT … WHERE rule_code IN ('helb')
                → 0 rows  ◄── EMPTY RETURN
```

**Identity is not lost inside payroll.** It is lost at exactly two boundaries:
1. **Payroll → Returns**, because the *string key* the return engine matches on (`rule_code`) was never aligned to the pack.
2. **Payroll → Remittance liabilities**, because the R4 writer has no code path for custom deductions at all — this loss is unconditional and independent of configuration.

---

## 5. Root cause classification

| Class | Applies | Detail |
|---|---|---|
| User configuration problem | **Yes — primary** | `payroll_rule_code` and `scheme_component_id` left blank on the HELB type |
| UI design problem | **Yes — contributing** | `CustomDeductionDialog.tsx:291` renders "Pack rule code (advanced)" as a **free-text input** with no picker of installed-pack rule codes, no validation against `statutory_scheme_components`, and no warning that an installed return template expects `helb`. `scheme_component_id` is **not exposed in the UI at all**. |
| Remittance architecture problem | **Yes — real gap** | `post-payroll-gl` R4 never writes `payroll_liabilities` for custom deductions, so no custom deduction — statutory-bound or ordinary — can ever appear on the Liabilities tab |
| Localization pack problem | **Partial** | The KE pack ships the HELB *return template*, *authority*, and *scheme component*, but ships **no `helb` payroll rule** and **no `helb_number` employee statutory identifier**, so `employee.helb_number` on the return would render blank even once rows appear |
| Missing validation | **Yes** | The pack lint exists but (a) is not wired into the publish gate, and (b) has no concept of tenant `custom_deduction_types`, so it cannot warn "template HELB_LR expects rule_code `helb` and nothing emits it" |
| Return template problem | No | HELB_LR is correctly authored against the documented convention |
| Payroll posting problem | No (for the observed symptom) | The runs simply were never posted |
| Legitimate current behavior | **Partially** | An *unbound* custom deduction correctly staying out of a statutory return is intentional and right |

---

## 6. Expected enterprise architecture

The three-concept distinction the brief asks about **does exist in this codebase**, expressed as `statutory_scheme_components.component_type`:

- **A. Mandatory statutory** → `component_type = 'mandatory'` (paye, nssf, shif, housing_levy, helb_employee)
- **B. Voluntary-but-statutory** → `component_type = 'voluntary'` (nssf_voluntary) — pack-published component, bound to a tenant `custom_deduction_type` via `scheme_component_id` for the per-employee amount
- **C. Ordinary employer-defined** → `custom_deduction_types` with both binding columns NULL (gym, SACCO, parking)

**HELB belongs in category B**, but the pack currently classifies `helb_employee` as `mandatory`. This is why the pack lint did not demand a `statutory_reporting_bindings` row for it (that rule only fires for voluntary/employer/top-up), and why the template falls back to raw `filters.rule_codes` matching.

The intended design (Design C in the brief) is:

```text
Localization pack publishes:  authority → scheme → scheme_component (rule_code, gl_liability_role)
                              + return template + reporting bindings + remittance schedule
Tenant creates:               custom_deduction_type BOUND to that scheme_component
Employee assignment:          per-employee amount only
Payroll:                      emits payslip_line under the pack's rule_code
Posting:                      creates payroll_liabilities keyed by that rule_code
Returns:                      sums payslip_lines by rule_code / binding
```

Account mapping alone is **not** sufficient and was never intended to be (Design A is rejected by the code): `payroll_liabilities.rule_code` — not `liability_account_id` — is the join key for the whole remittance and return chain.

---

## 7. Odoo / Workday / Oracle / SAP comparison

Only findings bearing on voluntary-statutory third-party deductions:

- **Odoo** — statutory items with a national formula are pure salary rules; items with an employee-specific amount but a mandatory external payee (HELB) are a **salary rule + "Other Input Type"**, shipped by the `l10n_ke_hr_payroll` localization module, with GL accounts/partners attached by `l10n_ke_hr_payroll_account`. HELB is **pack-shipped, not customer-invented**.
- **Workday** — three explicit layers: Deduction definition → worker-level Voluntary Deduction Election → **Deduction Recipient** (reusable third-party payee with bank details). Grouped under "Payroll Third-Party Payments".
- **Oracle HCM** — deduction = element; payee = separate **Third-Party Payment Method** for a third-party person/organization; a distinct flow step generates payments to third-party payees.
- **SAP** — deduction = wage type on IT0014/IT0015; payee = **vendor via the 3PR wage-type-to-vendor mapping**; a separate Third-Party Remittance evaluation run does settlement.
- **ADP** — hard line between statutory taxes (payee implicit) and garnishment/third-party deduction codes (explicit payee, separate SmartCompliance subsystem).

**Convergent conclusions relevant here:**
1. The payee/recipient is **always separate from both the deduction definition and the employee assignment**. This codebase's `statutory_authorities` is that object; it exists but is not reachable from an ordinary custom deduction.
2. Return participation is driven by a **classification/binding on the deduction**, not by the GL account. This codebase agrees (`rule_code` / `scheme_component_id`).
3. A voluntary-but-statutory deduction like HELB is **shipped by the localization pack**, not hand-created by the customer. Here it was hand-created — which is exactly why it lacks the pack's identity.

---

## 8. Gap analysis

| Area | Current behavior | Expected behavior | Gap? | Evidence |
|---|---|---|---|---|
| Custom deduction definition | Free-text `payroll_rule_code`, `scheme_component_id` hidden from UI | Pick from installed-pack scheme components | **Yes (UI)** | `CustomDeductionDialog.tsx:291` |
| HELB identity in payroll | `rule_code='custom_helb'` | `rule_code='helb'` + `scheme_component_id=92aaab80…` | **Yes (config)** | `payslip_lines` row |
| Identity preservation | 4 handles retained on the payslip line | Retained | **No** | `compute-payroll:4194-4226` |
| Liability account | `helb_payable` role declared on the scheme component; type points at an account | OK | **No** | `statutory_scheme_components.gl_liability_role` |
| GL posting | Not posted; JE line would carry account + description only, `contact_id=null` | JE line traceable to the deduction | **Yes (minor)** | `post-payroll-gl:886-909` |
| Remittance liability | Custom deductions never produce a `payroll_liabilities` row | Bound (and arguably all) custom deductions should | **Yes (architecture)** | `post-payroll-gl:425-441, 1120-1301` |
| HELB return template | Correctly authored, filters on `helb` | OK | **No** | `HELB_LR.body.filters` |
| `employee.helb_number` column | No `helb_number` statutory identifier type installed | Pack should declare it | **Yes (pack)** | `employee_statutory_identifiers` |
| HELB payroll rule | Absent from `payroll_statutory_rules` | Present, or explicitly assignment-driven | **Yes (pack)** | live query |
| `helb_employee` component_type | `mandatory` | `voluntary` (amount is per-employee, opt-in) | **Yes (pack)** | `statutory_scheme_components` |
| Pack lint | Exists; not wired to publish gate; blind to tenant custom deductions | Enforced at publish + a runtime "no emitter for this template" diagnostic | **Yes (validation)** | `localization-pack/ops/lint.ts` |

---

## 9. Recommended remediation

### Must fix
1. **Set the binding on the tenant's HELB deduction type** — `payroll_rule_code = 'helb'` and `scheme_component_id = 92aaab80-98d3-481d-894a-a9cc4ca7c8e2`, then recompute the affected runs. This alone makes the HELB return populate its amount column.
2. **Post the payroll runs.** PAY-0086 / PAY-0088 are approved but unposted; no liability of any kind exists yet.
3. **Extend `post-payroll-gl` R4 so custom deductions produce `payroll_liabilities` rows.** Use `payroll_rule_code` when present, `custom_<code>` otherwise, resolving `authority_name` through `scheme_component → scheme → statutory_authorities` when bound. This is the one true architectural gap and it affects gym/SACCO third-party payables just as much as HELB.

### Should improve
4. **Replace the free-text "Pack rule code" input with a picker** of scheme components published by the org's installed packs (showing scheme, authority, and `component_type`), writing both `payroll_rule_code` and `scheme_component_id` atomically. Keep free-text as an escape hatch behind an "advanced" toggle.
5. **Add a return-readiness diagnostic**: for each installed return template, warn when `filters.rule_codes` contains a code that no active statutory rule and no custom deduction type emits. Surface it on the Returns tab and in `payroll_return_diagnostics` rather than silently generating an empty file.
6. **Wire `localization-pack/ops/lint.ts` into the publish gate** so a pack cannot go live with dangling account roles, missing identifiers, or unbacked template rule codes.
7. **Fix the KE pack's HELB content**: reclassify `helb_employee` as `voluntary`, add a `helb_number` employee statutory identifier type, add a `statutory_reporting_bindings` row for HELB_LR, and add a HELB remittance schedule so `compute_remittance_due_date` can resolve.
8. **Add `deduction_type_id` / `rule_code` provenance to custom-deduction journal lines** (or at minimum populate `contact_id` with the authority's contact) so the GL is self-describing.

### Do not change
- Custom deduction calculation, caps, min-net floor, approval, or the event audit trail.
- The `payslip_lines` identity model — it is already sufficient.
- The rule that an **unbound** custom deduction stays out of statutory returns. That is correct: a gym membership must never surface on a KRA/HELB return.
- The `statutory_authorities → schemes → components → bindings` model. It is the right shape and matches Workday/Oracle/SAP.
- NSSF Voluntary's configuration — it is the reference implementation.
- Mandatory statutory rules, garnishment liabilities, loan/advance posting paths.

---

## 10. Regression risks

| Proposed change | Mandatory statutory | Existing packs | NSSF / PAYE | Payroll posting | Existing returns | Ordinary custom deductions | Liability accounting |
|---|---|---|---|---|---|---|---|
| Set HELB bindings (#1) | None | None | None | None | None | None | Low — introduces a new `helb` liability once #3 lands |
| Post the runs (#2) | None | None | None | Expected first post | None | None | Creates the first liability rows; verify GL mappings first |
| R4 covers custom deductions (#3) | None | None | None | **Medium** — new rows in `payroll_liabilities`; the `(run, rule_code)` unique index keeps re-posts idempotent, but every existing custom deduction across all tenants will start appearing on the Liabilities tab. Needs a backfill decision for already-posted runs and a UI review so ordinary deductions (gym, SACCO) read sensibly there. | None (returns key off `payslip_lines`, not liabilities) | **Medium** — this is the visible behavior change | Medium — new open liabilities affect ageing/dashboard totals |
| Rule-code picker (#4) | None | None | None | None | None | Low — free-text escape hatch preserved | None |
| Return diagnostics (#5) | None | None | Low — may surface pre-existing warnings on other templates | None | Low — advisory only, no output change | None | None |
| Lint in publish gate (#6) | None | **Medium** — may block republish of packs that currently pass silently; run the lint in report-only mode first | None | None | None | None | None |
| KE pack HELB fixes (#7) | None | KE pack version bump + upgrade proposal | None | None | Improves HELB_LR only | None | Adds a HELB remittance schedule |
| JE provenance (#8) | None | None | None | Low — additive columns on new lines only | None | None | Low |
