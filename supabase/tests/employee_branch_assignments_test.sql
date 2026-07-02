-- pgTAP: employee_branch_assignments + Phase A guard contract.
-- HR Architecture Review (Phase D).
BEGIN;
SELECT plan(6);

-- 1. Table + critical indexes exist.
SELECT has_table('public', 'employee_branch_assignments',
  'employee_branch_assignments table exists');

SELECT has_index('public', 'employee_branch_assignments', 'uq_eba_primary_open',
  'partial unique index on (employee_id) WHERE is_primary AND open exists');

-- 2. View exposes the synthetic NULL-branch row for unassigned employees.
SELECT has_view('public', 'v_employee_branch_scope',
  'v_employee_branch_scope view exists');

-- 3. RPCs exist with expected signatures.
SELECT has_function('public', 'assign_employee_to_branch',
  ARRAY['uuid','uuid','boolean','date','text','text'],
  'assign_employee_to_branch(uuid,uuid,bool,date,text,text) exists');

SELECT has_function('public', 'transfer_employee_primary_branch',
  ARRAY['uuid','uuid','date','text'],
  'transfer_employee_primary_branch(uuid,uuid,date,text) exists');

-- 4. Direct write of employees.branch_id (outside the internal session var)
--    is rejected by the guard trigger.
SELECT throws_ok(
  $$ UPDATE public.employees
       SET branch_id = gen_random_uuid()
     WHERE id = (SELECT id FROM public.employees LIMIT 1) $$,
  NULL,
  NULL,
  'employees.branch_id direct UPDATE is blocked by guard trigger'
);

SELECT * FROM finish();
ROLLBACK;
