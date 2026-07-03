---
name: Salary structure graph engine wire-in
description: Rule-graph engine (runStructureEngine) is invoked in production per salary_structures.use_structure_engine; traces persist to payroll_rule_traces
type: feature
---
- `supabase/functions/compute-payroll/index.ts` imports and invokes `runStructureEngine` per employee when `salary_structures.use_structure_engine=true` AND `payroll_salary_rules` has active rows for that structure.
- Graph earnings map onto `basicSalary/housingAllowance/transportAllowance/otherEarnings` by category (`basic`/`allowance`) and by code (`housing*`, `transport*`).
- Graph `deduction` and `employer_contribution` lines replace the flat-component walk downstream; legacy structures unchanged.
- Any `runStructureEngine` error is fatal (`STRUCTURE_ENGINE_ERROR`, HTTP 400) — never a silent fall-through to legacy.
- Traces (`StructureRuleTrace[]`) persist to `payroll_rule_traces` (RLS: payroll-read, engine-only write via service_role).
- Backfill: `public.migrate_components_to_rules(uuid)` — SECURITY DEFINER, idempotent, flips `use_structure_engine=true` when new rules were created. Requires payroll write.
- Guard test: `src/test/architecture/structure-engine-wired.test.ts` fails if the import, branch, invocation, error surface, or trace persistence disappears.
- Historical recompute caveat: graph rules are read live; snapshotting into `salary_structure_rule_sets` is the follow-up. Flat components remain byte-identical via existing snapshot.
