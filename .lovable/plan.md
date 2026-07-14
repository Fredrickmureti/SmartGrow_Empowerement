## Diagnosis

You are correct: we should **not create another account**. The localization-pack installer already created the correct statutory liability account, **NSSF Payable**, and mapping voluntary NSSF to that same account is the right accounting treatment.

The current approval blocker is a system bug, not a user setup problem.

### What is happening now

The latest payroll run contains two deduction lines for the same KES 2,000 voluntary NSSF enrollment:

1. **Correct line**
   - `rule_code = custom_nssf_voluntary`
   - `source = custom_deduction`
   - includes `deduction_type_id`
   - includes `gl_liability_account_id = NSSF Payable`
   - this line is postable and does not need a GL Account Mapping row.

2. **Incorrect duplicate line**
   - `rule_code = custom_nssf_voluntary_<assignment_id>`
   - no `source = custom_deduction`
   - no `deduction_type_id`
   - no GL account stamped on it
   - the run-level validator treats it like a statutory/default payroll rule and asks for:
     - `custom_nssf_voluntary_<assignment_id>_payable`
     - `custom_nssf_voluntary_payable`

That is why approval says payroll setup is required even though the custom deduction type is already mapped.

## Business rule to preserve

Voluntary NSSF Type 105 is:

- employee-side only
- remitted to NSSF
- posted to the existing **NSSF Payable** account
- configured per employee through `employee_custom_deductions`
- not a salary-structure rule
- not a new chart-of-accounts role
- not a separate statutory-rule setup item

## Implementation plan

### 1. Fix compute-payroll so custom deductions are not emitted twice

Update the custom-deduction computation path so the deduction amount is not left inside the generic `deductionsDetail` bucket that later becomes a second generic payslip line.

Expected result for one voluntary NSSF enrollment:

```text
payslip_lines:
  nssf_voluntary or custom_nssf_voluntary
    source.source = custom_deduction
    source.deduction_type_id = <custom_deduction_type_id>
    source.assignment_id = <employee_custom_deduction_id>
    source.gl_liability_account_id = <NSSF Payable account id>
```

There should be **no** extra line like:

```text
custom_nssf_voluntary_<assignment_id>
```

### 2. Make the run-level GL validator custom-deduction aware

Update `payroll_required_gl_mappings_for_run` so it excludes payslip lines where:

```text
source.source = 'custom_deduction'
```

Those lines are validated by `post-payroll-gl` against `custom_deduction_types.gl_liability_account_id`, not by `default_account_settings`.

This prevents future custom deductions from being misclassified as statutory/default mapping keys.

### 3. Keep GL Account Mapping for statutory/default payroll roles only

Do not add these keys to `default_account_settings`:

```text
custom_nssf_voluntary_payable
custom_nssf_voluntary_<assignment_id>_payable
```

They are invalid because they are generated from tenant enrollment data, not from the localization pack’s chart-of-accounts role catalog.

### 4. Fix the approval/setup message routing

Where the run returns custom-deduction mapping problems, route the user to:

```text
Payroll → Configuration → Rule Type Definitions / Custom Deduction Types
```

not:

```text
Configure statutory rules
```

The “Configure statutory rules” button is misleading here because voluntary NSSF is being consumed as a custom deduction type bound to a pack rule code, not as a missing statutory rule.

### 5. Recompute the affected draft run after the fix

After implementation, recompute the draft run so stale duplicate payslip lines and stale `GL_MAPPING_MISSING` blocker issues are regenerated cleanly.

Verification should show:

- no `custom_nssf_voluntary_<assignment_id>_payable` missing key
- no `custom_nssf_voluntary_payable` missing key
- approval no longer blocked by those custom keys
- the voluntary NSSF line remains KES 2,000
- the posting path credits the already-mapped NSSF Payable account

## No schema expansion

No new COA account is needed.
No new statutory account role is needed.
No new salary-structure row is needed.

This is a wiring correction: custom deductions must stay on their per-type GL mapping path and must not leak into the generic statutory/default GL mapping validator.