# Salary Structures — Continuation Plan (COMPLETED)

All Phase 1–3 items in the original continuation plan are closed. Phases 4–8
remain out of scope and available for a follow-up turn.

## Shipped

### Step 1 — `runStructureEngine` wired into production ✅
- `supabase/functions/compute-payroll/index.ts` imports `runStructureEngine`,
  fetches `salary_structures.use_structure_engine` + `payroll_salary_rules`,
  and dispatches per employee.
- `STRUCTURE_ENGINE_ERROR` (HTTP 400) surfaces cycle/unresolved-token/
  expression errors as blocking `payroll_run_issues` — no silent fallback.
- Statutory tokens resolve via a `statutoryResolver` closure over Pass [B].

### Step 2 — Rule traces persisted ✅
- Migration `20260703224517_…` creates `public.payroll_rule_traces` with RLS
  (`user_can_access_business` + payroll read permission), grants scoped to
  `authenticated` (SELECT) and `service_role` (ALL), and per-employee inserts
  are written in the same block as `payslip_lines`.

### Step 3 — `migrate_components_to_rules` RPC ✅
- SECURITY DEFINER RPC in the same migration. Idempotent; flips
  `use_structure_engine=true` only when rules are actually created.
- Admin-gated "Migrate to rule graph" button in
  `src/pages/hr/payroll/SalaryStructures.tsx` calls the RPC via
  `supabase.rpc`, toasts the count, invalidates the list query.

### Step 4 — Phase 1 UI fixes ✅
- `useSalaryStructures.ts` uses a scoped query key, awaits invalidation, and
  applies an optimistic `setQueryData` insert on create success.
- Component editor branches on `computation_type` (Fixed vs Percentage) with
  suffix hints and a required `percentage_of` selector.

### Step 5 — Deduplication ✅
- `src/lib/payroll/garnishment-engine.ts` is a pure re-export of the
  canonical `supabase/functions/_shared/garnishment-engine.ts`.
- `disability_exemption` — a UI-only field the engine never read — removed
  from `computationMethods.ts` after the field-parity guard test caught the
  drift.
- Field-alias (`cap` ↔ `ceiling`) unification confirmed in engine + simulator.

### Step 6 — Guard tests ✅
- `src/test/architecture/structure-engine-wired.test.ts` — 5 assertions on
  the compute-payroll call site (import, branch, invocation,
  `STRUCTURE_ENGINE_ERROR`, `payroll_rule_traces` write).
- `src/test/architecture/no-duplicate-garnishment-engine.test.ts` — fails if
  the client shim re-introduces local logic.
- `src/test/architecture/computation-method-field-parity.test.ts` — every
  UI-declared field key must appear in the engine source.
- `src/test/architecture/simulator-dispatch-parity.test.ts` — every engine
  switch case + every UI-declared method must have a mapping in
  `ENGINE_METHOD_TO_KIND`.
- pgTAP `supabase/tests/migrate_components_to_rules_test.sql` — asserts
  first-call rule creation + flag flip, field mapping (fixed / percentage /
  expression, `amount_base` retention), and second-call idempotency.

## Verification

- `bunx vitest run src/test/architecture/{structure-engine-wired,no-duplicate-garnishment-engine,computation-method-field-parity,simulator-dispatch-parity,salary-rule-graph}.test.ts` → 29/29 green.
- Full-project vitest failures on unrelated arch suites (workspace-shell,
  warehouse-stock helper) are pre-existing and outside the salary-structure
  subsystem.

## Deferred (not in this continuation)

Phases 4 (enterprise component attributes), 5 (structure versioning beyond
current snapshots), 6 (retro authoring + distinct GL JE for retro pay), 7
(historical simulator RPC), 8 (SalaryStructures operational cockpit). Each is
a standalone turn.
