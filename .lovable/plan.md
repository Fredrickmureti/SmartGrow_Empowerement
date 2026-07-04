
# Custom Deduction Types — Architectural Audit

## 1. What this subsystem actually is (traced, not assumed)

Table: `public.payroll_rule_types`. Frontend: `CustomDeductionTypes.tsx`, `CustomDeductionTypeDialog.tsx`, `usePayrollRuleTypes.ts`. Route: `/hr/payroll/configuration/deduction-types`.

**Cross-module trace of every consumer of `payroll_rule_types`:**

| Consumer | What it reads | What it does with it |
|---|---|---|
| `PayrollStatutoryRules.tsx` | `code`, `label`, `parameter_schema` | Populates the rule-editor's "type" dropdown; renders parameter field hints in `RuleParameters` |
| `CustomDeductionTypes.tsx` | Full row | CRUD screen |
| `CustomDeductionTypeDialog.tsx` | Full row | Writes rows |
| `compute-payroll` edge function | **Nothing** | Never queried. Verified. |
| `payroll_salary_rules` / rule-graph engine | Nothing | No reference |
| `payslip_lines` / `payslips` | Nothing | No reference |
| `post-payroll-gl` / journal entries | Nothing | No reference |
| `employee_loans`, `employee_advances`, `employee_garnishments` | Nothing | No FK, no lookup |
| Any RPC, trigger, view | Nothing | No reference |

There is **no foreign key** anywhere in the schema pointing at `payroll_rule_types`. Its `code` is stuffed into `payroll_statutory_rules.rule_type` as free text — a soft, unenforced label. The comment on the table itself admits this: *"Dynamic rule type definitions for payroll statutory rules"*.

**Conclusion:** `payroll_rule_types` is a **form-schema catalog for the Statutory Rules editor**. It is neither a deduction type, nor a deduction, nor a driver of any payroll behaviour. Renaming it "Custom Deduction Types" and giving it its own top-level workspace was an information-architecture error introduced in Phase C of the Statutory Rules split.

## 2. Business-event lifecycle — the honest version

```text
User opens /hr/payroll/configuration/deduction-types
  → creates a "type" row (code, label, parameter_schema)
    → row lands in payroll_rule_types
      → NO business event fires
        → NO downstream consumer reacts
          → NEXT time someone opens the Statutory Rules editor,
             the type dropdown has one more option and the
             parameter form renders `amount` or `rate` fields
END OF LIFECYCLE.
```

That is the entire causal chain. Nothing on an employee changes. No payslip line is created. No GL entry is posted. No approval is triggered. No audit event beyond the row's own `updated_at`.

## 3. Field-by-field audit

| Field | Purpose claimed | Actual behaviour | Verdict |
|---|---|---|---|
| `code` | Machine name referenced by rules | Free-text tag copied into `payroll_statutory_rules.rule_type`; no FK, no uniqueness across pack + tenant, no migration path when renamed | Weakly wired |
| `label` | Human name | Rendered in one dropdown, one list | OK |
| `description` | Docs | Rendered on the card | OK |
| `parameter_schema` | Drives compute | Drives only form rendering in `RuleParameters`. Compute engine reads `payroll_statutory_rules.parameters` + `computation_method` directly | Misleading |
| `is_bracket` | Selects bracket editor | Dialog hard-codes `is_bracket:false` — user can never set it here | **Dead in this workspace** |
| `is_system` | Guard against edits/delete | Enforced only client-side | Weakly enforced |
| `is_active` | Soft-delete flag | Dialog hard-codes `true`; delete is hard-delete. No listing filter surfaces inactive types | **Dead** |
| `sort_order` | Ordering | Applied in `useRuleTypes` | OK |
| `business_id` | Scope | Never written by the dialog; `useRuleTypes` never filters by it. Column is orphaned | **Dead** |
| **Missing** `computation_method` | — | Dialog forces user to pick `flat_amount` \| `percentage_of_gross`, then discards it and infers it back later by looking for the `rate` key. Fragile, lossy, unnecessary | **Bug** |

## 4. Enterprise concepts the workspace claims to cover — and doesn't

The subtitle enumerates *"loans, advances, SACCO, gym fees"*. Each of these already has a **first-class, correctly modelled** home:

| Concept | Real home | What it does that this workspace does not |
|---|---|---|
| Loans | `loan_types`, `employee_loans`, `loan_repayment_schedule`, `payroll_loan_recovery_policy` | Lifecycle (requested → approved → disbursed → recovering → recovered), amortisation, skip-overrides, GL wiring, compute-payroll consumption |
| Advances | `employee_advances`, `advance_repayment_schedule` | Full lifecycle, min-net floor, recovery in compute-payroll |
| Garnishments | `employee_garnishments`, `garnishment_kind_defaults`, `garnishment_carry_forward`, `garnishment_lifecycle_events` | Court-order metadata, priority ordering, carry-forward, audit |
| Statutory (PAYE / SHIF / NSSF / housing levy) | `payroll_statutory_rules` + localization packs | Pack governance, effective dating, upgrade inbox, conflicts, provenance |
| Salary rules (allowances, custom formulas) | `payroll_salary_rules` + `salary_structure_rule_sets` + structure engine | Ordered graph, expressions, snapshots, traces |
| Benefits | `benefit_plans`, `employee_benefits`, `benefit_enrollment_windows` | Enrollment windows, employer/employee split |

The only thing *not* covered by any of the above is: **a truly ad-hoc, tenant-defined, recurring or one-time deduction that isn't a loan, advance, garnishment, statutory item, benefit, or salary-structure line** — e.g. "gym membership deducted at KES 1,500/month". Today the ERP has **no first-class home for that**. This workspace pretends to be that home but is not.

## 5. Architectural risks

1. **Naming lies.** The screen title, subtitle, nav label, permission (`manageStatutoryRules`), and route all say "deduction types". No deduction exists here. Payroll officers will assume creating a row here causes deductions.
2. **`is_bracket=false` hard-coded.** Bracket-shaped rule types (PAYE brackets, tiered rates) can NOT be authored from this workspace even though the underlying table supports them — but the workspace calls itself the tenant-authoring surface for rule types. Users hit a silent ceiling.
3. **`computation_method` round-trip.** Dialog stores a schema-shape and re-infers method via `keys.has("rate")`. Renaming a parameter key changes the inferred method. This is fragile.
4. **`business_id` orphan.** Migration 20260421213742 added the column but nothing writes or filters by it, so tenant/business scoping is inconsistent with the rest of the payroll module.
5. **`is_active` and soft-delete unused.** Delete is hard, breaking any historical rule that still references a deleted code.
6. **No lifecycle for the actual gap** (ad-hoc recurring/one-time employee deductions): no assignment table, no effective dates, no approval, no suspension, no reversal, no compute-payroll integration, no payslip line contract, no GL mapping, no reporting classification, no year-end handling.

## 6. Recommendation

**Do not add features to the current `payroll_rule_types` workspace pretending it is a deduction engine. Fix the IA lie first, then decide whether to add a real "Custom Deductions" subsystem in a separate slice.**

### Slice 1 — Truth in labelling (small, safe, no schema change to consumers)

1. **Rename route + nav + page** from *Custom Deduction Types* to ***Rule Type Definitions*** (or *Statutory Rule Type Catalog*). New route: `/hr/payroll/configuration/rule-types`. Add a 301-style redirect from the old path. Update `navs.ts`, `PayrollRoutes.tsx`, page title, dialog copy, and the architecture guard test.
2. **Rewrite the page copy** to say what it truly does: *"Defines the shape (label + parameter schema) that appears in the Statutory Rules editor for tenant-authored rule types. Does not create deductions. To manage employee deductions see Loans, Advances, Garnishments, or Salary Structures."*
3. **Add outbound links** on the empty state and header to Loans, Advances, Garnishments, Salary Structures, Statutory Rules — so users who mis-navigated here find the right home.
4. **Fix the `computation_method` round-trip:** persist the picked method on the type row (add `computation_method text` column, backfill from `methodForSchema`, drop the inference). Statutory rule editor should default `computation_method` from the picked type.
5. **Un-hard-code `is_bracket`:** allow the dialog to author bracket-shaped types (matches the underlying table capability the workspace claims to expose).
6. **Wire `is_active`:** the delete action becomes soft delete; the list filters out inactive by default; `useRuleTypes` already filters `is_active=true`, so historical rules keep resolving their type label.
7. **Drop the orphan `business_id` column** OR start writing/filtering by it consistently. Given rule-type catalogs are workspace-level HR-policy artefacts (same reasoning as `leave_types` in `useLeaveTypes.ts`), drop the column and mark the table `SCOPE-EXEMPT` explicitly in `businessScopedTables.ts`.
8. **Add pgTAP test** pinning: no FK to `payroll_rule_types` from anywhere except future explicit rule-type FKs; `payroll_statutory_rules.rule_type` values referenced in `payroll_rule_types` are the only tenant-defined values; deletes cascade-safely.

### Slice 2 — (Deferred, only if the real gap is confirmed by a tenant) *Ad-hoc Custom Deductions*

If — and only if — workspaces actually need a first-class ad-hoc deduction that is not a loan, advance, garnishment, statutory, or benefit, model it properly rather than bolting fields onto `payroll_rule_types`. Sketch (not built now):

- `custom_deduction_types` — tenant catalog: code, label, `deduction_kind (recurring|one_time|voluntary|involuntary)`, `tax_treatment (pre_tax|post_tax)`, `is_taxable`, `is_employer_contribution`, `computation_method`, `parameters jsonb`, `gl_liability_account_id`, `gl_expense_account_id`, `payslip_group`, `sort_order`, `requires_approval`, `is_active`, `version`.
- `employee_custom_deductions` — assignment: `type_id`, `employee_id`, `effective_from`, `effective_to`, `amount_or_rate_override`, `status (pending|approved|active|suspended|cancelled|completed)`, `cumulative_cap`, `min_net_floor`, `approver_id`, `approved_at`, `lifecycle events` table.
- Consumers to wire: `compute-payroll` (new branch after loans/advances, before net), `payslip_lines` (new `source='custom_deduction'`), `post-payroll-gl` (respect the GL mapping), `payroll_readiness_rules` (mapping-completeness rule), reversal/correction pipeline, termination final-pay recovery, year-end reporting classification, employee self-service visibility flag.
- Governance: this must NOT overlap with garnishments (court-ordered, priority-ordered) or loans (amortisation). A DB `CHECK` or trigger ensures a type declared as `deduction_kind='installment_loan'` is not allowed here — those belong to `loan_types`.

Slice 2 is a separate audit and separate build. Do not start it as part of this cleanup.

### Explicitly out of scope for this slice

- Rewriting compute-payroll (nothing needs to change there).
- Touching Statutory Rules governance (packs, upgrades, conflicts).
- Touching loans / advances / garnishments (they are correctly modelled).
- Any UI polish beyond copy/nav/links needed for truth-in-labelling.

## 7. Deliverable of this slice

A single, honest configuration screen named *Rule Type Definitions* that owns exactly the concept it manipulates, plus a fixed `computation_method` persistence, un-hard-coded `is_bracket`, real soft-delete, orphan-column cleanup, and a pgTAP guard. Total surface: ~200 lines of frontend edits, one migration, one test file.
