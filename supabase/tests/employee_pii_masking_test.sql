-- C-HR-4 — PII masking guards.
BEGIN;
SELECT plan(6);

-- 1. The safe view exists and is granted to authenticated
SELECT has_view('public', 'v_employees_safe', 'v_employees_safe view exists');
SELECT ok(
  has_table_privilege('authenticated', 'public.v_employees_safe', 'SELECT'),
  'authenticated may SELECT from v_employees_safe'
);

-- 2. The PII columns on employees are NOT directly selectable by authenticated
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.employees', 'national_id', 'SELECT'),
  'authenticated cannot SELECT employees.national_id directly'
);
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.employees', 'bank_account_number', 'SELECT'),
  'authenticated cannot SELECT employees.bank_account_number directly'
);

-- 3. get_employee_pii is SECURITY DEFINER and callable by authenticated
SELECT ok(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'get_employee_pii'),
  'get_employee_pii is SECURITY DEFINER'
);

-- 4. employee_credentials denies SELECT to authenticated
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.employee_credentials', 'SELECT'),
  'authenticated has no SELECT on employee_credentials'
);

SELECT * FROM finish();
ROLLBACK;
