## Diagnosis

You were right to challenge this.

The business event is:

```text
Employee elects voluntary statutory deduction
→ payroll computes a custom deduction
→ approved payroll result stores the legal deduction amount
→ statutory return should report that amount under the pack-defined voluntary return column
```

What I found in the current tenant:

- The employee’s **NSSF voluntary custom deduction** is configured and active.
- The approved payroll run `PAY-0018` produced a `payslip_lines` row:
  - `rule_code = nssf_voluntary`
  - `employee_amount = 2000`
  - `source.source = custom_deduction`
- The current `NSSF_RET` template has `VOLUNTARY` mapped to `sum_rule.nssf_voluntary.employee`.
- The most recent generated return payload now shows `voluntary: 2000`, but older generated returns show `voluntary: 0`.
- The architectural problem remains: the custom deduction payslip line still has `scheme_component_id = null`, even though the custom deduction type is linked to the NSSF voluntary statutory component.

So my previous implementation fixed the immediate string-code path, but did **not** fully implement the enterprise architecture I described. The generator is still functionally relying on `rule_code` conventions instead of the durable statutory component binding.

## What is wrong architecturally

The return should not depend on this fragile assumption:

```text
template column source = sum_rule.nssf_voluntary.employee
matches payslip_lines.rule_code = nssf_voluntary
```

That is better than before, but still not enterprise-grade.

The durable contract should be:

```text
custom_deduction_types.scheme_component_id
→ payslip_lines.scheme_component_id
→ statutory_reporting_bindings.scheme_component_id
→ return column
```

That is what scales to Ghana Tier 3, Uganda voluntary NSSF, pension top-ups, union dues that are legally reportable, country-specific employer components, and future localization packs without inventing more string conventions.

## Implementation plan

### 1. Fix payroll result provenance

Update `compute-payroll` so custom deduction lines carry the statutory component identity when the deduction type has one.

For employee custom deductions:

```text
custom_deduction_types.scheme_component_id
→ emitted payslip_lines.scheme_component_id
```

This makes the approved payroll result legally self-describing.

### 2. Backfill existing approved result metadata safely

Run a narrow migration that backfills only missing `payslip_lines.scheme_component_id` where all of these are true:

- line source is `custom_deduction`
- line source contains `deduction_type_id`
- the referenced `custom_deduction_types` row has `scheme_component_id`
- the line currently has `scheme_component_id IS NULL`

This does **not** change money, net pay, GL posting, or tax. It only restores missing provenance on immutable payroll results.

### 3. Upgrade statutory return aggregation to component-aware reporting

Change `generate-statutory-return` so it loads `statutory_reporting_bindings` for the template and uses component-bound line amounts when a column is bound.

For a binding like:

```text
NSSF_RET.voluntary
→ NSSF voluntary component
→ employee side
```

The generator should aggregate:

```text
sum payslip_lines.employee_amount
where payslip_lines.scheme_component_id = binding.scheme_component_id
```

not merely:

```text
sum payslip_lines.employee_amount
where payslip_lines.rule_code = 'nssf_voluntary'
```

### 4. Preserve backward compatibility

Keep existing `sum_rule.<code>.<side>` behavior for templates and tenants that have not yet adopted component bindings.

Resolution order:

```text
1. Explicit statutory_reporting_bindings for the template column
2. Existing source token resolver fallback
```

So current packs do not break, but new/updated packs get structural correctness.

### 5. Make government files use the same component-aware row context

Ensure CSV/PDF/gov_xlsx/gov_xml all consume the same resolved row context, so the audit artifact and authority upload cannot disagree.

This matters because users may be viewing the primary `gov_xlsx`, while the internal payload or audit CSV may show something else.

### 6. Add regression tests for the business event

Add tests that lock the full lifecycle:

```text
custom deduction type linked to statutory component
→ employee assignment produces payslip line with scheme_component_id
→ NSSF_RET voluntary column reads 2000 from component binding
→ no Kenya-specific branch is introduced
```

Also add an architecture guard that fails if `statutory_reporting_bindings` exists but return generation ignores it.

### 7. Regenerate the affected return

After the architecture is fixed, regenerate the current tenant’s NSSF return for the affected period so the active artifact reflects the approved payroll result.

## Expected outcome

The NSSF voluntary amount will come from the employee’s actual voluntary custom deduction, through the approved payroll result, into the statutory return by statutory component identity — not by a fragile Kenya-specific string match.