
## Root cause of the 42702 error

The failing RPC is not actually `archive_salary_structure` — it's the helper `public._ss_authorize(uuid, text)` it calls on line 1.

```sql
CREATE FUNCTION public._ss_authorize(...)
RETURNS TABLE(org_id uuid, biz_id uuid, structure_name text,
              is_active boolean, archived_at timestamptz)  -- ← OUT params
LANGUAGE plpgsql AS $$
...
  SELECT organization_id, business_id, name,
         COALESCE(is_active, true), archived_at            -- ← ambiguous
    INTO v_org, v_biz, v_name, v_active, v_arch
  FROM public.salary_structures WHERE id = p_id;
```

In PL/pgSQL, `RETURNS TABLE(...)` column names are in scope as variables inside the body. Both `is_active` and `archived_at` collide with the table columns of the same name in the SELECT list. Postgres raises `42702 column reference "is_active" is ambiguous` — surfaced through *every* caller (`archive`, `rename`, `restore`, `delete`, `deletion_report`), which matches the reported "Archive **or** Rename fails" symptom.

The previous agent's follow-up migration (`20260703231720`) only added `#variable_conflict use_column` to `archive_salary_structure`'s own body. That body never had the conflict — the conflict is one call deeper, in `_ss_authorize`, which was left untouched. Rename still fails for the same reason.

## Lifecycle architecture review (already in place)

Contrary to a symptom-only reading, the lifecycle scaffolding the previous agent built is architecturally sound and matches enterprise ERP patterns. Verified by reading the migration + pgTAP tests (`salary_structure_delete_blocked_test.sql`, `salary_structure_rename_test.sql`) + `mem/features/salary-structure-graph-engine.md`:

- **Rename** is always allowed (even on frozen/published structures) — matches Odoo/Workday "metadata is editable, calculation snapshot is not". Old name is snapshotted in the lifecycle event payload; historical payslips reference `rule_set_id` (an immutable versioned snapshot in `salary_structure_rule_sets`), so renaming cannot rewrite history.
- **Archive** flips `is_active=false` + stamps `archived_at`. Not destructive. Contracts continue to resolve; new assignments are prevented at the UI/service layer.
- **Restore** is the inverse.
- **Delete** is preflight-guarded by `salary_structure_deletion_report` (must be archived AND zero contracts AND zero payslips AND zero in-flight runs) + name-confirmation + FK `ON DELETE RESTRICT` from `employee_contracts`. This is the correct "archive-by-default, delete only when never used" enterprise stance.
- **Audit** is captured in `salary_structure_lifecycle_events` with `created/renamed/archived/restored/deleted` and structure name snapshot. Row is written *before* the DELETE and has no FK to `salary_structures` so it survives.
- **Historical reproducibility** is preserved because payslips snapshot to `salary_structure_rule_sets` (immutable, versioned, rule-hashed) — verified by `payslip-rule-set-snapshot.test.ts` and the graph-engine memory.

No architectural change to the lifecycle model is warranted at this pass. The single defect is the SQL ambiguity blocking every lifecycle operation from executing.

## Fix

One migration that recreates `public._ss_authorize` with the OUT-vs-column collision resolved. Two options, both valid; I'll use both belt-and-suspenders:

1. Add `#variable_conflict use_column` so bare `is_active` / `archived_at` in the SELECT resolve to table columns.
2. Rename the returned columns to non-colliding names (`out_is_active`, `out_archived_at`) and update every caller to read the renamed fields.

Option 2 alone is the cleaner long-term fix (removes the trap entirely), so the plan uses it. Callers touched:

- `archive_salary_structure` — `a.is_active` → `a.out_is_active`; drop the now-unnecessary `#variable_conflict use_column` pragma the follow-up migration added.
- `rename_salary_structure` — no field reads, no change beyond re-creation for consistency.
- `restore_salary_structure` — no field reads.
- `salary_structure_deletion_report` — `a.archived_at` → `a.out_archived_at`.
- `delete_salary_structure` — no field reads.

Verification:
- Existing pgTAP tests `salary_structure_rename_test.sql` and `salary_structure_delete_blocked_test.sql` already cover rename + archive + delete happy-path and error paths. They will pass once the helper stops throwing 42702.
- Manual: from the Salary Structures page, Rename → success; Archive → success; Restore → success; attempt Delete on an active structure → `foreign_key_violation`; archive then Delete with wrong name → `invalid_parameter_value`; archive + correct name + no references → succeeds and writes a `deleted` lifecycle event.

## Steps

1. Write a single migration `fix_ss_authorize_ambiguity.sql` that:
   - `CREATE OR REPLACE FUNCTION public._ss_authorize` with OUT columns renamed to `out_org_id, out_biz_id, out_structure_name, out_is_active, out_archived_at`.
   - `CREATE OR REPLACE` the five callers (`archive`, `restore`, `rename`, `deletion_report`, `delete`) to read the renamed fields. Rename now dereferences `a.out_org_id` / `a.out_biz_id`; archive uses `a.out_is_active` for `from_state`; deletion_report uses `a.out_archived_at`.
   - Re-apply the existing `REVOKE ALL` / `GRANT EXECUTE ... TO authenticated` on the recreated functions.
2. No client-side changes required — RPC signatures and return shapes are unchanged (`_ss_authorize` is internal, marked `REVOKE ALL FROM public`).
3. No schema changes, no data migration.

## Out of scope (explicitly)

The broader "salary-structures-as-canonical-payroll-engine" audit the wider prompt requests is a large multi-week program that already has substantial prior work landed (graph engine wire-in, rule-set snapshots, immutability guards, GL readiness, PII masking, structure engine test). Doing that audit as part of a lifecycle-RPC bugfix would conflate two efforts and delay unblocking the user. This plan restores lifecycle operations to a working state so that broader audit can proceed against a functioning baseline; I can open it as a separate planning pass on request.
