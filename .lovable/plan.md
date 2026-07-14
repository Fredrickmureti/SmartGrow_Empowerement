
# Voluntary Statutory Contributions — Architectural Investigation

Reasoned in business events; verified against the codebase and against Odoo, Oracle HCM, SAP ECP, Workday, PeopleSoft GP. This is an **architecture proposal**, not a fix for NSSF.

---

## 1. End-to-end business-event map (as it exists today)

```text
Employee enrolled in NSSF Voluntary
      │
      ▼
Contract / employee_custom_deductions row
      │
      ▼
Payroll run created
      │
      ▼
compute-payroll
   • pack statutory rules   → payslip_line (rule_code='nssf',            source.statRuleId=…)
   • custom deduction types → payslip_line (rule_code='nssf_voluntary',  source.source='custom_deduction')
      │
      ▼
payslip_lines  ◄── canonical, rule_code-keyed, country-agnostic
      │
      ├──► post-payroll-gl        ✅ reads ALL rule_codes generically → NSSF Payable credited
      ├──► payslip PDF            ✅ shows the line
      ├──► statutory liabilities  ✅ accrued
      │
      └──► generate-statutory-return
                 │
                 └── reads localization_pack_return_templates.body.columns[]
                             │
                             └── NSSF_RET.columns has 7 entries; no `voluntary` column
                                        │
                                        ▼
                             ❌ nssf_voluntary never added to extraRuleCodes,
                                never aggregated, no cell to render into
```

**The canonical result (`payslip_lines`) is correct.** GL, payslip, liabilities all consume it uniformly. **The return generator is also correct** — its resolver already understands `sum_rule.<code>.<side>` in a fully country-agnostic way. The break is entirely at the *template configuration* layer.

---

## 2. Root cause (classified)

**Primary — Pack content gap.** `localization_pack_return_templates.NSSF_RET.body.columns` was never extended with a `voluntary` column. A separate `custom_deduction_advisory` pack row *documents* the intended binding (`template_code:'NSSF_RET', column_key:'voluntary', source:'sum_rule.nssf_voluntary.employee'`) but nothing materialises it into the live template body. The lint gate does not detect this.

**Contributing — Architecture gap.** There is **no structural link** from a `custom_deduction_types` row (or its `payroll_rule_code`) to the return template it should feed. Correctness is enforced only by string convention:

- `payslip_lines.rule_code` (from `custom_deduction_types.payroll_rule_code`)
- ↔ `return_templates.body.columns[].source = 'sum_rule.<code>.<side>'`

Two independent artifacts, no referential integrity, no CI check. Any localization pack that adds a voluntary/optional statutory component the same way will silently drop that component from its return.

**Not the cause:** compute-payroll (emits correctly), the resolver (`_shared/returnSourceResolver.ts`, fully generic), `payslip_lines` shape (has everything needed), GL posting, or the payslip.

---

## 3. Blast radius

Every KE return template shares the same generic contract and resolver: **SHIF/SHA, AHL/Housing Levy, PAYE (P10/P10A/P10D), NITA, HELB, future pension top-ups** are all vulnerable to the identical silent omission the moment a voluntary/top-up variant is introduced as a `custom_deduction_type`. Same for every future country pack — the failure mode is not Kenya-specific; it is a platform-level contract gap.

---

## 4. What industry-grade payroll systems do

Consistent pattern across Odoo, Oracle HCM, SAP ECP, Workday, PeopleSoft GP:

1. **Voluntary is a sibling component of the mandatory scheme, not a generic custom deduction.** It's an Element / Wage Type / Salary Rule / Contribution Component that shares the mandatory scheme's **register / balance / accumulator / contribution register**.
2. **Reports read the register, not raw paylines.** Every component declares which regulatory field/box/column it feeds. A component cannot exist without a reporting classification.
3. **Country content publishes the scheme + its known voluntary variants** (Oracle 401k catch-up, PeopleSoft VPF, UK AVC). Tenants add net-new voluntary components *within* a scheme; they can't invent unclassified deductions that escape reporting.
4. **One canonical resolved result** (RT cluster / balances / accumulators / payslip lines) feeds every downstream. No parallel recomputation.

Our `payslip_lines` layer is correctly built to principle #4. What we lack is principles #1–#3: **a first-class Statutory Scheme + Component model, and pack-published Reporting Categories** that make return coverage a structural property rather than a naming convention.

---

## 5. Proposed enterprise architecture

Introduce a scheme/component model on top of the existing (already-correct) canonical `payslip_lines`. Nothing in the compute engine, resolver, or GL path changes semantically — we replace a naming convention with a referential contract.

### 5.1 New pack-owned entities

| Entity | Purpose |
|---|---|
| `statutory_schemes` | Country-scoped scheme (NSSF, SHA, AHL, PAYE, NITA, HELB). `authority_id` FK, `country`, `code`. Published by the localization pack. |
| `statutory_scheme_components` | Rows under a scheme: `component_type ∈ {mandatory, voluntary, employer, top_up}`, `party ∈ {employee, employer}`, `rule_code`, `default_gl_liability_account_role`, `tax_treatment`, limits. Published by the pack; tenants may add rows only via a governed extension. |
| `statutory_reporting_bindings` | Explicit binding: `(scheme_component_id → return_template_code, column_key, side)`. This is the durable replacement for today's string-matched `sum_rule.<code>` convention. |

### 5.2 Custom deductions become derived, not primary

`custom_deduction_types.scheme_component_id` (nullable FK). Two flavours:

- **Statutory-linked custom deduction** — must reference a `statutory_scheme_components` row of `component_type='voluntary'` or `'top_up'`. Inherits `rule_code`, authority, GL role, reporting binding from the component. This is where NSSF Voluntary belongs.
- **Non-statutory custom deduction** — no scheme link (e.g., staff SACCO). Behaves exactly as today.

Voluntary NSSF stops being "a custom deduction that happens to be named `nssf_voluntary`" and becomes "an enrollment against the pack-published NSSF/voluntary component." No new UI concept for the tenant — they still create custom deductions — but selection is scheme-aware.

### 5.3 Return templates become derived views of bindings

`localization_pack_return_templates.body.columns[]` is generated (or validated) from `statutory_reporting_bindings` for that template. Two enforcement options, both cheap:

- **Publish-time materialisation:** on pack install / upgrade, expand bindings into `body.columns` deterministically.
- **Lint gate (minimum):** `lint-localization-pack` fails if any `statutory_scheme_component` with a reporting binding is not represented as a column in the target template — and vice versa.

Either way, "column exists" becomes a *consequence* of "component is published + bound," not a manual editorial step.

### 5.4 One canonical result — reinforced

`payslip_lines.scheme_component_id` (nullable FK) is stamped by `compute-payroll` for any line whose rule maps to a component (both mandatory pack rules and statutory-linked custom deductions). All downstream consumers keep reading `payslip_lines`; returns can now aggregate by `scheme_component_id` (structural) instead of by `rule_code` string match. `rule_code` remains for backward compatibility and non-scheme lines.

Result: every downstream — GL, returns, tax certificates, statutory reports, dashboards, exports, APIs — consumes the same rows, and coverage of voluntary/employer/top-up components in returns becomes a **schema-enforced invariant**, not a copy-editing task.

### 5.5 Lint / architecture tests (non-negotiable)

- Pack lint: every `statutory_scheme_component` with `component_type ∈ {voluntary, employer, top_up}` must have a `statutory_reporting_bindings` row **or** an explicit `reports_to = none` (audited).
- Pack lint: every `custom_deduction_advisory` binding shipped by a pack must correspond to an actual `statutory_reporting_bindings` row after install — the "documented but never applied" failure mode becomes impossible.
- Architecture test: `generate-statutory-return` must not filter by hard-coded rule codes (already true; lock it in).

---

## 6. Kenya migration path (data-only, no compute changes)

1. Seed `statutory_schemes` for NSSF, SHA, AHL, PAYE, NITA, HELB from existing pack authority + rule data.
2. Seed `statutory_scheme_components` — mandatory rows from existing `payroll_statutory_rules`; voluntary/employer rows from what returns are *supposed* to show (NSSF Voluntary, SHA voluntary top-up if any, AHL employer, PAYE fringe, …).
3. Seed `statutory_reporting_bindings` for every existing return template column, plus the previously-missing voluntary bindings (NSSF `voluntary` first).
4. Point existing `custom_deduction_types.nssf_voluntary` at the NSSF/voluntary/employee component.
5. Re-materialise `return_templates.body.columns` from bindings; NSSF_RET gains the `voluntary` column automatically.
6. Recompute affected draft runs (payslip_lines stamped with `scheme_component_id`); returns now populate voluntary without further intervention.

No changes needed to `compute-payroll` semantics, `post-payroll-gl`, `returnSourceResolver`, or payslip rendering — they continue to consume `payslip_lines` canonically; they simply gain a stronger key to group by.

---

## 7. What we are explicitly *not* doing

- Not adding an ad-hoc `voluntary` column to `NSSF_RET` as a one-off patch. That closes the Kenya symptom and leaves SHA/AHL/PAYE/NITA/HELB and every future pack exposed to the same silent omission.
- Not adding authority/statutory fields directly to `custom_deduction_types`. That entrenches the "custom deduction is the primary object" mental model, which is precisely what industry-grade systems avoid.
- Not touching the canonical `payslip_lines` shape beyond adding one FK. The engine and downstream resolver are already correct.

---

## 8. Deliverables of the eventual build phase (for reference — not for this turn)

1. Migrations for `statutory_schemes`, `statutory_scheme_components`, `statutory_reporting_bindings`, plus FK on `custom_deduction_types` and `payslip_lines`.
2. Kenya pack seed for the three tables above, covering all six schemes.
3. `install-localization-pack` / `apply-localization-pack-upgrade` publish-time materialisation of `return_templates.body.columns` from bindings.
4. `lint-localization-pack` gates described in §5.5.
5. `compute-payroll` stamps `scheme_component_id` when the rule maps to a component (mandatory + statutory-linked custom deductions).
6. Backfill + recompute for existing draft runs.
7. Architecture tests locking the invariants.

Ready to switch to build mode and implement §5 + §6 when you approve.
