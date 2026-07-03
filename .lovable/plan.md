
# Salary Structures — Architectural Audit & Remediation Plan

## 1. Verdict

**Salary Structures are NOT the authoritative payroll calculation engine today.** They are a *named container* whose components are snapshotted into `salary_structure_rule_sets.components` and evaluated by an inline legacy two‑pass resolver inside `supabase/functions/compute-payroll/index.ts` (lines 1929–1983). The purpose-built rule‑graph engine (`compute-payroll/structureEngine.ts:runStructureEngine`, backed by `payroll_salary_rules` and edited by `SalaryRuleGraphEditor.tsx`) is fully wired to schema, tests, and UI **but is never invoked in production** — rules authored through the graph editor silently produce zero effect on real payslips.

Payroll math currently lives in **five distinct places** with three material duplications and one dead canonical implementation. Localization publication, immutability, versioning, retro engine plumbing, GL/report derivation are all solid. The gap is between the *designed* calculation model (rule graph + expression engine) and the *executing* calculation model (inline legacy resolver).

## 2. Business‑Event Trace (as it actually executes)

```text
Contract references salary_structure_id
   └─► compute-payroll pre-loop:
         resolve_or_publish_rule_set()  → salary_structure_rule_sets.components (JSON snapshot)
                                          ├─ legacy flat model (computation_type/percentage_of)
                                          └─ payroll_salary_rules is NOT read here
         payroll_statutory_rules (pack-published, effective-dated, superseded_by)
         benefit_plans, loans, advances, garnishments, attendance, leave, termination
   └─► per-employee loop:
         [A] earnings   ← inline 2-pass (fixed → percentage)  ...index.ts:1929
         [B] statutory  ← computeOneRule dispatch on computation_method
                          (Pass A: reduces_taxable; Pass B: tax + employer levies)
         [C] structure deductions/contributions  ← inline resolver again
         [D] benefits   [E] loans   [F] advances   [G] garnishments (inline)
         → payslip_lines (authoritative sink; pins rule_version_hash + pack_version_id)
   └─► post-payroll-gl / reports / tax certificates / remittances → READ ONLY
```

The orphaned canonical path:

```text
SalaryRuleGraphEditor → payroll_salary_rules  (sequence, condition_expression,
                        amount_expression, statutory_ref, parent_rule_id)
                        └─► runStructureEngine ── never called ──► ⛔
```

## 3. Calculation Sites Inventory

| # | Site | File | Status |
|---|---|---|---|
| 1 | Statutory dispatch (`computeOneRule` + 6 methods) | `compute-payroll/index.ts:507` | Canonical |
| 2 | Legacy 2‑pass salary component resolver | `compute-payroll/index.ts:1929` | Canonical (legacy) |
| 3 | Rule‑graph engine (`runStructureEngine`) | `compute-payroll/structureEngine.ts:129` | **Orphaned / dead in prod** |
| 4 | Garnishment loop (inline) | `compute-payroll/index.ts:2546` | Canonical |
| 5 | Garnishment pure lib | `src/lib/payroll/garnishment-engine.ts:72` | **Duplicate of #4** |
| 6 | Rule simulator (localization editor) | `src/features/localization/lib/ruleSimulator.ts:79` | **Duplicate of #1**, dispatches off `parameters.type` (wrong key) with a `rateAsFraction` heuristic that does not exist in the engine |
| 7 | Expression engine (server, Pratt parser + sandbox) | `compute-payroll/expressionEngine.ts` | Canonical |
| 8 | Expression validator (client) | `src/lib/payroll/expressionValidator.ts` | Pure re‑export (safe) |
| 9 | `computationMethods.ts` normalizer | `src/lib/payroll/computationMethods.ts` | UI validator; field‑name drift vs engine (`ceiling` vs `cap`) |
| 10–20 | benefits / loans / advances / proration / OT / leave / termination / tax method / taxable adjust / GL / reports | see subagent trace | Canonical or Derived |

## 4. Critical Findings

### C‑SS‑1 — `runStructureEngine` is dead code in production (Critical)
`payroll_salary_rules` is designed to be the canonical rule graph. `compute-payroll/index.ts` never imports or invokes `structureEngine.ts`. Every rule authored through `SalaryRuleGraphEditor.tsx` is silently ignored by real payroll. This is the single biggest architectural defect and the root cause of the "Rule Graph functionality requires architectural validation" concern.

### C‑SS‑2 — Two parallel component models (Critical)
Legacy: `salary_components` (flat: `computation_type` fixed/percentage/formula, `percentage_of`, `computation_value`).
Modern: `payroll_salary_rules` (graph: `condition_expression`, `amount_expression`, `sequence`, `parent_rule_id`, `statutory_ref`).
Both are writable, only the legacy one runs. There is no migration or bridge.

### C‑SS‑3 — Garnishment engine duplicated (High)
`src/lib/payroll/garnishment-engine.ts` mirrors `index.ts:2546–2662` and is out of sync (missing carry‑forward, employer fees, `total_accrued` vs `total_paid`). Any policy fix must be applied twice.

### C‑SS‑4 — Rule simulator uses wrong discriminator (High)
`ruleSimulator.ts` dispatches on `parameters.type` while the engine dispatches on `rule.computation_method`. Its `rateAsFraction` heuristic causes divergent previews for rates stored as decimals. Pack authors get misleading test output.

### C‑SS‑5 — No dependency graph / cycle detection (Medium)
Even in the orphaned engine, ordering is a linear `sequence.sort()`. `parent_rule_id` is stored but never traversed. There is no topological sort and no cycle detection anywhere. Circular `result[code]` references would evaluate to 0 silently.

### C‑SS‑6 — Component model is missing enterprise attributes (Medium)
`salary_components` lacks: pensionable flag, recurring vs one‑time, effective_from/to per component, eligibility filter, currency, cost allocation (`analytic_distribution_id`), GL account override, payslip visibility, proration policy, overtime‑base inclusion, leave‑encashment base, severance inclusion, net/gross participation, retro behaviour. Some equivalents exist at `payroll_statutory_rules` / `contract_compensation_components` but not at the structure‑component level.

### C‑SS‑7 — Salary structures are not versioned or effective‑dated (Medium)
`salary_structures` has no `version`, `effective_from`, `effective_to`, `status` (draft/active/archived). The *rule set* attached to it is versioned + hashed (good), and payslips pin `rule_version_hash` + `pack_version_id` (good), so historical *math* is reproducible, but structure‑level metadata edits (name, description, reassignments) have no temporal audit trail.

### C‑SS‑8 — UI defects rooted in the fragmentation (High‑visibility, Low‑fix)
- "Newly created structure appears only after refresh": query key is `["salary-structures", currentOrg?.id]`; invalidation uses `["salary-structures"]`. Prefix match works, so the real cause is likely the query fires before `currentBusiness?.id` is available or the list is filtered by business elsewhere. Needs a targeted trace + optimistic update in `useSalaryStructures.createStructure`.
- "Fixed vs Percentage behaves identically": the form persists `computation_type` but the input field renders the same numeric control for both and there is no unit affordance (KES vs %), no `percentage_of` selector when `percentage`, and no formula editor when `formula`.

### C‑SS‑9 — Retro pay is half‑built (High)
Engine drain + `retro_pay_adjustments` + delta payslips exist. But (a) no authoring UI, (b) back‑dated `employee_compensation_history` edits do not auto‑enqueue a retro, (c) retro amounts are folded into the regular run's GL journal — no distinct retro JE for audit.

### C‑SS‑10 — Historical recompute / dry‑run RPC missing (Medium)
There is no `simulate_payroll(period, employee, rule_set_hash)` surface. Proving reproducibility today requires manual queries against `pack_versions.snapshot`. ADR‑0056 P2.c already tracks this as deferred.

### C‑SS‑11 — `computationMethods.ts` field drift (Medium)
Editor writes `ceiling` but engine reads `cap` (`index.ts:349`). Editor writes `employer_rate`/`employee_rate` shape not consistently honored by all method dispatchers. Silent zero.

### C‑SS‑12 — SalaryStructures page shows CRUD, not operational reality (UX)
No column for: version, employees using it, effective window, localization pack, payroll frequency, last run date, draft/active status, dependencies, warnings, rule count, health. Editor is a form, not a payroll admin cockpit.

### Findings verified as already solid (no action)
- Statutory engine is truly country‑agnostic (arch tests + eslint rule + pgTAP guards enforce it).
- Localization publish → propose → apply → rollback lifecycle is complete, with `pack_rule_conflicts` protecting tenant edits.
- Payslip / run / line immutability guards are country‑agnostic and cover the correction‑delta pattern.
- GL, reports, tax certs, remittances are strictly derived from `payslip_lines` — no formula duplication downstream.
- Expression engine is a single source (client is a pure re‑export). Sandbox is real (Pratt parser, whitelisted identifiers/functions, no `eval`).

## 5. Phased Implementation Plan

Each phase is independently shippable and does not break existing payroll runs. Phase 1 is the bug‑surface the user reported. Phases 2–4 close the architectural debt. Phase 5+ are enterprise‑grade uplifts.

### Phase 1 — Stop the visible bleeding (1–2 days)
- Fix "list doesn't refresh": add optimistic insert into `["salary-structures", orgId]` cache and remove the stale `enabled: !!currentOrg?.id` race; ensure the query re‑fires when `currentBusiness` changes if the page filters by business.
- Fix "fixed vs percentage input": in `SalaryStructures.tsx` component editor, branch the input by `computation_type`:
  - `fixed` → currency input with org currency suffix
  - `percentage` → number input with `%` suffix + required `percentage_of` selector (BASIC / GROSS / another component code)
  - `formula` → mount a small monaco/textarea backed by `validateExpression` from `src/lib/payroll/expressionValidator.ts`
- No behaviour change to the engine.

### Phase 2 — Retire duplicate calculators (2–3 days)
- Delete `src/lib/payroll/garnishment-engine.ts` and refactor its tests to import a pure function extracted from `compute-payroll/index.ts` (move the inline garnishment block into `compute-payroll/garnishmentEngine.ts`, import from both engine and tests).
- Rewrite `src/features/localization/lib/ruleSimulator.ts` to be a thin wrapper around a new exportable pure function inside `compute-payroll/statutoryEngine.ts` that takes `(rule, ctx)` and returns the amount — same dispatch on `computation_method`, no `rateAsFraction` heuristic.
- Reconcile `computationMethods.ts` field names with what the engine actually reads (`cap` vs `ceiling`, employer/employee rate shapes) and add an arch test that fails if a documented field is not consumed.

### Phase 3 — Wire the rule graph into production (5–8 days)  ← the architectural fix
Goal: `payroll_salary_rules` becomes the single canonical earnings/deductions/employer‑contrib model; `salary_components` becomes a compatibility view.
1. Add topological sort + cycle detection to `runStructureEngine` (walk `parent_rule_id` + expression AST dependency extraction from the existing parser).
2. Backfill: one‑time migration + RPC `migrate_components_to_rules(structure_id)` that materialises each `salary_components` row as a `payroll_salary_rules` row with equivalent `amount_expression` (`BASIC`, `GROSS * 0.1`, etc.).
3. Feature‑flag in `compute-payroll`: if `structure.uses_rule_graph = true` (new column, default false), call `runStructureEngine` for section [A] and [C]; otherwise legacy path. Migrate structures one by one via `migrate_components_to_rules`.
4. Once all structures are migrated, remove legacy resolver and drop `salary_components` (keep view).
5. Extend audit trail: the bracket‑trace sink already exists for statutory — add the same trace surface to structure‑engine outputs so payslip lines carry per‑expression provenance.

### Phase 4 — Enterprise component attributes (3–5 days)
Extend `payroll_salary_rules` (or a joined `payroll_rule_attributes` table) with: `is_pensionable`, `is_recurring`, `effective_from`, `effective_to`, `eligibility_expression`, `currency`, `analytic_distribution_id`, `gl_account_id`, `payslip_visibility`, `proration_policy`, `overtime_base`, `leave_encashment_base`, `severance_base`, `net_gross_flag`, `retro_behaviour`. Reference them from the engine at appropriate stages (proration in [A], GL mapping at payslip‑lines write, taxable/pensionable flags in Pass A of [B]).

### Phase 5 — Version & effective‑date salary structures (2–3 days)
Add `salary_structures.version`, `effective_from`, `effective_to`, `status` (`draft|active|archived`), `parent_structure_id`. Publishing a change forks a new version; contracts pin `salary_structure_version_id` at compute time; payslip stamp already extends via `rule_version_hash` (no schema break).

### Phase 6 — Retro authoring + distinct GL JE (3 days)
- UI: `RetroPayScheduler` inside SalaryStructures / Employee compensation history that inserts into `retro_pay_adjustments`.
- Trigger: back‑dated `employee_compensation_history` insert auto‑enqueues a retro row.
- `post-payroll-gl`: emit a separate JE with `journal_type='retro'` for lines where `retro_of_payslip_id IS NOT NULL`.

### Phase 7 — Historical simulator RPC (2 days)
`simulate_payroll(payslip_id)` reads the stored `rule_version_hash` + `pack_version_id`, rehydrates rule sets from `pack_versions.snapshot` and `salary_structure_rule_sets`, re‑runs the engine, returns diff. Backs a "Reproduce this payslip" affordance.

### Phase 8 — SalaryStructures page becomes an operational cockpit (2 days)
Rework the list into a cockpit with columns/badges for: version, status (draft/active/archived), employees using, active contracts, last payroll run using it, effective window, localization pack, rule count, warnings (missing GL mapping, orphaned components, cycle in graph, unresolved token), health traffic light. Detail page: dependency graph tab, usage tab, audit tab, simulator tab (Phase 7).

## 6. Sequencing Notes

- Phase 1 is safe to ship immediately (pure UI/hook).
- Phase 2 is prerequisite for Phase 3 (removes wrong dispatcher before we start relying on graph output).
- Phase 3 is the load‑bearing change; feature‑flagged per‑structure so a bad migration cannot blast production.
- Phases 4–8 layer cleanly on top and can be prioritised against product needs.

## 7. Explicit Non‑Goals

- No changes to `payroll_statutory_rules`, localization pack lifecycle, or the correction‑delta / immutability guards — those are already enterprise‑grade.
- No rewrite of GL posting, reports, remittances, or tax certificates — they correctly consume `payslip_lines` and require nothing.
- No country‑specific code anywhere; every step must remain pack‑driven.
