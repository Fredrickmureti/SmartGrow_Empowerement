
# Salary Structures — Continuation Plan

## Verified state of the previous agent's work

Confirmed against source, not notes:

- **Phase 3 (partial, safe slice):** `expressionEngine.extractIdentifiers`, `structureEngine.topoSortRules`, `StructureRuleTrace` + `traceSink`, cycle detection, and 8 new tests are present in `supabase/functions/compute-payroll/{expressionEngine,structureEngine}.ts` and `src/test/architecture/salary-rule-graph.test.ts`. The `salary_structures.use_structure_engine` column exists (migration `20260510103130`).
- **NOT done:** `compute-payroll/index.ts` never imports `structureEngine.ts` and never reads `use_structure_engine`. The graph engine is still dead in production — the headline defect (C‑SS‑1) is unresolved.
- **NOT done:** Phase 1 UI (list refresh race, fixed‑vs‑percentage input branching in `SalaryStructures.tsx`).
- **NOT done:** Phase 2 dedup — `src/lib/payroll/garnishment-engine.ts`, `src/features/localization/lib/ruleSimulator.ts`, and `computationMethods.ts` `ceiling`/`cap` drift all still present.
- **NOT done:** `migrate_components_to_rules` RPC, `payroll_rule_traces` persistence.
- Phases 4–8 untouched (correctly deferred).

Plan below picks up exactly at the wire-in and closes Phases 1–3 to production quality.

## Scope (what this plan ships)

### Step 1 — Wire `runStructureEngine` into production (the load-bearing fix)

In `supabase/functions/compute-payroll/index.ts` (around the section [A]/[C] legacy 2‑pass resolver at lines ~1929–1983):

1. Import `runStructureEngine`, `StructureRuleTrace` from `./structureEngine.ts`.
2. In the pre-loop resolver where the structure is loaded, also fetch `salary_structures.use_structure_engine` and, when true, fetch that structure's rows from `payroll_salary_rules` (ordered, with `parent_rule_id`, `condition_expression`, `amount_expression`, `sequence`, `statutory_ref`, `rule_type`).
3. Per employee: if the resolved structure has `use_structure_engine=true` **and** at least one active rule, call `runStructureEngine({ rules, workEntryTypes, workEntries, employee, contract, statutoryResolver, traceSink })` and use its `earnings`/`deductions`/`employer_contributions` outputs in place of the legacy resolver for sections [A] and [C]. Statutory dispatch [B], benefits, loans, advances, garnishments continue to use their canonical paths unchanged.
4. If `runStructureEngine` returns non-empty `errors` (cycle, unresolved token, expression error) surface as a blocking `payroll_run_issues` row for that employee — do **not** silently fall through to legacy.
5. Statutory tokens referenced from a rule graph resolve via a `statutoryResolver` closure that returns already-computed statutory amounts from Pass [B]; this avoids double-running the statutory dispatcher.

Feature gate: purely per-structure via the existing boolean column. Legacy path remains the default. No new env flag.

### Step 2 — Persist rule traces (audit + future simulator)

Migration: `payroll_rule_traces` (id, org_id, business_id, payroll_run_id, payslip_id, employee_id, rule_id, rule_code, condition_passed, base_value, amount, dependencies text[], error text, evaluated_at). RLS: read via existing `has_payroll_read`, insert only from service_role; SELECT/INSERT grants to `authenticated`/`service_role` per public-schema grant rules. Add to `supabase_realtime` NOT required.

`compute-payroll/index.ts` writes the `traceSink` returned per employee alongside `payslip_lines` in the same transactional block. This gives per-expression provenance without changing `payslip_lines`.

### Step 3 — Backfill RPC `migrate_components_to_rules(p_structure_id uuid)`

Migration adds a SECURITY DEFINER function that, for the given structure:

- Reads each `salary_components` row.
- Inserts a matching `payroll_salary_rules` row: `rule_type` from category, `sequence` from source order, `amount_expression` derived (`fixed` → literal; `percentage` → `"${percentage_of} * ${value/100}"`; `formula` → passthrough), `condition_expression` = `'true'`.
- Sets `salary_structures.use_structure_engine = true` in the same statement.
- Idempotent: no-ops if rules already exist for that structure.

Called from a new "Migrate to rule graph" button in `SalaryStructures.tsx` (admin-gated by existing payroll write permission).

### Step 4 — Phase 1 UI fixes (as originally scoped)

`src/hooks/useSalaryStructures.ts`:
- Ensure the query key includes business scope if the list is business-filtered (`["salary-structures", currentOrg?.id, currentBusiness?.id]`) and invalidate with the same prefix.
- On create success: also perform an optimistic `setQueryData` insert so the list updates before the refetch resolves. Root-cause the "refresh required" symptom rather than only adding invalidation.

`src/pages/hr/payroll/SalaryStructures.tsx`:
- In the component editor, branch the value input on `computation_type`:
  - `fixed` → numeric input with the org currency suffix.
  - `percentage` → numeric input with `%` suffix + required `percentage_of` selector (`BASIC` / `GROSS` / peer component code).
  - `formula` → textarea backed by `validateExpression` from `src/lib/payroll/expressionValidator.ts` with inline error rendering.

### Step 5 — Phase 2 deduplication

- Extract the inline garnishment block from `compute-payroll/index.ts` into `supabase/functions/_shared/garnishment-engine.ts` as a pure function. Rewrite `src/lib/payroll/garnishment-engine.ts` as a thin re-export mirror (same pattern as `payslipClassifier.ts` / `expressionValidator.ts`), so tests and any future client callers exercise the same code the engine runs. Sync missing fields (carry-forward, employer fees, `total_accrued` vs `total_paid`).
- Extract a pure `evaluateStatutoryRule(rule, ctx)` from the statutory dispatcher in `index.ts` into `compute-payroll/statutoryEngine.ts`. Rewrite `src/features/localization/lib/ruleSimulator.ts` to delegate to it (dispatch on `computation_method`, drop the `rateAsFraction` heuristic, drop the wrong `parameters.type` discriminator).
- Reconcile `src/lib/payroll/computationMethods.ts`: rename `ceiling` → `cap` (and any other drifted fields) to match what the engine actually reads. Add `src/test/architecture/computation-method-field-parity.test.ts` that fails if a UI-declared field is not consumed by the engine.

### Step 6 — Guard tests (regression protection)

- `src/test/architecture/structure-engine-wired.test.ts` — greps `compute-payroll/index.ts` for the `runStructureEngine(` call site and the `use_structure_engine` branch; fails if either disappears.
- `src/test/architecture/no-duplicate-garnishment-engine.test.ts` — fails if `src/lib/payroll/garnishment-engine.ts` contains logic that is not a re-export from `supabase/functions/_shared/garnishment-engine.ts`.
- pgTAP `supabase/tests/migrate_components_to_rules_test.sql` — asserts idempotency and that the RPC flips `use_structure_engine` only when rules are actually created.

## Explicitly out of scope (deferred, unchanged from previous plan)

Phases 4 (enterprise component attributes), 5 (structure versioning), 6 (retro authoring + distinct GL JE), 7 (historical simulator RPC), 8 (SalaryStructures operational cockpit). Each is a separate turn once Steps 1–6 stabilise in production.

## Verification checklist before handing back

- `tsgo` clean, `bunx vitest run` green (existing 14 + new tests).
- pgTAP suite green.
- Manual: create a fresh salary structure, run `migrate_components_to_rules`, execute a payroll run, confirm `payroll_rule_traces` rows exist and payslip totals match the legacy run for the same employee within 1 minor unit.

## Technical notes

- Import protection: `structureEngine.ts` and `expressionEngine.ts` are `supabase/functions/compute-payroll/` files (Deno). Browser code must keep importing them only through the existing `src/lib/payroll/expressionValidator.ts` re-export pattern to avoid Vite pulling Deno code into the client bundle.
- Grants: every new public table (`payroll_rule_traces`) gets `GRANT SELECT ... TO authenticated; GRANT ALL ... TO service_role;` in the same migration, RLS ON, policies scoped to org/business + `has_payroll_read`.
- No `service_role_key` in client code; the RPC is invoked from a `createServerFn` with `requireSupabaseAuth` + `has_role('admin')` check, following the modern server-function pattern.
- No country-specific code — pack-driven throughout.
