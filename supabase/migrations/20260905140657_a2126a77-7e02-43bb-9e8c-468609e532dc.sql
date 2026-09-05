DELETE FROM public.permission_group_rules r
USING public.permission_groups g
WHERE r.permission_group_id = g.id
  AND (
    g.is_deprecated = true
    OR g.name IN ('Accountant (ERP)','Attendance Officer','HR Manager','Internal User','Internal Users',
                  'Payroll Admin','Payroll Officer','Portal User','Project Manager','Recruiter',
                  'Sign User','Time Off Officer')
  );

DELETE FROM public.permission_group_rules
WHERE module NOT IN ('clients','loan_products','applications','loans','repayments','collections',
                     'accounting','treasury','reports','contacts','branches','team','settings','audit');

DELETE FROM public.permission_groups g
WHERE (
    g.is_deprecated = true
    OR g.name IN ('Accountant (ERP)','Attendance Officer','HR Manager','Internal User','Internal Users',
                  'Payroll Admin','Payroll Officer','Portal User','Project Manager','Recruiter',
                  'Sign User','Time Off Officer')
  )
  AND NOT EXISTS (SELECT 1 FROM public.member_permission_groups m WHERE m.permission_group_id = g.id);

ALTER TABLE public.permission_group_rules
  DROP CONSTRAINT IF EXISTS permission_group_rules_module_supported_chk;

ALTER TABLE public.permission_group_rules
  ADD CONSTRAINT permission_group_rules_module_supported_chk
  CHECK (module IN ('clients','loan_products','applications','loans','repayments','collections',
                    'accounting','treasury','reports','contacts','branches','team','settings','audit'));