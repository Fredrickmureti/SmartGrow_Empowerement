# Phase C — Wire `accounting_tag` from Work Entry Types into the GL

## Why

Today `payroll_work_entry_types.accounting_tag` is a configurable field with no
downstream effect. The GL posts a single `salary_expense` DR for the entire
gross. Enterprises need labour cost split by bucket (regular wages vs OT vs
holiday premium vs paid leave) so P&L, project costing and analytic
distributions line up with the rest of the ERP.

## Scope

Additive only. No behaviour change when every rule/WET leaves `accounting_tag`
NULL — the run still posts a single `salary_expense` DR and existing runs stay
byte-for-byte identical.

## Changes

1. **Schema** — one migration:
   - Add nullable `accounting_tag text` to `public.payslip_lines`.
   - Index `(payroll_run_id, accounting_tag)` for the GL aggregation query.

2. **compute-payroll** — stamp the tag when writing earning lines:
   - When inserting earning-category `payslip_lines` from a salary rule, copy
     `rule.accounting_tag` onto the row (rule already carries it via
     `structureEngine`).
   - No change to computed amounts. Tag is purely a routing dimension.

3. **post-payroll-gl** — split the salary expense debit:
   - Aggregate earning-category `payslip_lines` by `accounting_tag`.
   - For each non-null tag `T`, resolve `resolveAccount("salary_expense_" + T)`;
     fall back to the generic `salary_expense` mapping when the specific key
     is not mapped.
   - Emit one DR line per tag bucket labelled `<runLabel> — Salary Expense (T)`;
     the untagged remainder posts to the generic `salary_expense` as today.
   - Debit total remains `totalGross`; balance invariants unchanged.

4. **GL mapping resolver** — extend `payroll_required_gl_mappings_for_run` so
   the missing-mappings dialog only surfaces `salary_expense_<T>` keys when
   there is *no* generic `salary_expense` fallback. This keeps the preflight
   quiet for existing tenants.

5. **UI** — no changes required. The mapping page already surfaces any
   `salary_expense_*` key that the resolver reports.

## Out of scope (future phases)

- Analytic distribution splits by tag.
- Dead-field cleanup on `payroll_work_entry_types`.
- pgTAP coverage of the new aggregation (Phase E follow-up).

## Verification

- Run the existing payroll compute + post flow on a run with all-NULL tags →
  identical JE to before.
- Add one WET with `accounting_tag='OT'`, map `salary_expense_OT`, re-post →
  two salary-expense DRs (OT bucket + remainder), same total gross, balanced.
- Preflight resolver only asks for `salary_expense_OT` when the generic
  `salary_expense` key is unmapped.
