
CREATE TABLE public.governance_duties (
  duty_code text PRIMARY KEY,
  label     text NOT NULL,
  domain    text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.governance_duties TO authenticated;
GRANT ALL    ON public.governance_duties TO service_role;
ALTER TABLE public.governance_duties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "duties readable to authenticated"
  ON public.governance_duties FOR SELECT TO authenticated USING (true);

CREATE TABLE public.governance_sod_conflicts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_a     text NOT NULL REFERENCES public.governance_duties(duty_code) ON DELETE CASCADE,
  duty_b     text NOT NULL REFERENCES public.governance_duties(duty_code) ON DELETE CASCADE,
  severity   text NOT NULL DEFAULT 'high' CHECK (severity IN ('low','medium','high','critical')),
  rationale  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (duty_a < duty_b),
  UNIQUE (duty_a, duty_b)
);
GRANT SELECT ON public.governance_sod_conflicts TO authenticated;
GRANT ALL    ON public.governance_sod_conflicts TO service_role;
ALTER TABLE public.governance_sod_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sod conflicts readable to authenticated"
  ON public.governance_sod_conflicts FOR SELECT TO authenticated USING (true);

CREATE TABLE public.governance_duty_permission_map (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_code  text NOT NULL REFERENCES public.governance_duties(duty_code) ON DELETE CASCADE,
  module     text NOT NULL,
  operation  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (duty_code, module, operation)
);
GRANT SELECT ON public.governance_duty_permission_map TO authenticated;
GRANT ALL    ON public.governance_duty_permission_map TO service_role;
ALTER TABLE public.governance_duty_permission_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "duty map readable to authenticated"
  ON public.governance_duty_permission_map FOR SELECT TO authenticated USING (true);

INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('payroll.create',          'Create / edit payroll runs',         'payroll', 'Initiate or modify a payroll run before approval.'),
  ('payroll.approve',         'Approve payroll runs',               'payroll', 'Sign off a payroll run after review.'),
  ('payroll.execute',         'Execute payroll payments',           'payroll', 'Release net pay to employees / bank file.'),
  ('compensation.modify',     'Modify employee compensation',       'hr',      'Change salary, allowances or contract terms.'),
  ('compensation.approve',    'Approve compensation changes',       'hr',      'Sign off salary / contract changes.'),
  ('loan.request',            'Request employee loans',             'hr',      'Open a loan / advance application.'),
  ('loan.approve',            'Approve employee loans',             'hr',      'Sign off a loan / advance.'),
  ('loan.disburse',           'Disburse employee loans',            'hr',      'Release loan funds to the employee.'),
  ('leave.request',           'Request leave',                      'hr',      'Submit a leave application.'),
  ('leave.approve',           'Approve leave',                      'hr',      'Sign off a leave application.'),
  ('payment.create',          'Create vendor / customer payments',  'finance', 'Draft a payment.'),
  ('payment.approve',         'Approve payments',                   'finance', 'Sign off a payment before execution.'),
  ('payment.execute',         'Execute / release payments',         'finance', 'Push payment to bank / cash out.'),
  ('je.post',                 'Post journal entries',                'finance', 'Move a JE to posted state.'),
  ('je.reverse',              'Reverse journal entries',             'finance', 'Reverse a posted JE.'),
  ('vendor.create',           'Create / edit vendors',               'purchasing','Manage the vendor master.'),
  ('vendor.pay',              'Pay vendors',                         'finance', 'Approve / release vendor payments.'),
  ('refund.approve',          'Approve customer refunds',            'sales',   'Sign off a customer refund.'),
  ('inventory.adjust',        'Create inventory adjustments',        'inventory','Open stock adjustment / write-off.'),
  ('inventory.approve_adjustment','Approve inventory adjustments',   'inventory','Sign off stock adjustment / write-off.'),
  ('bank.modify',             'Modify bank account master',          'finance', 'Change bank account details.'),
  ('role.grant',              'Grant roles or permissions',          'security','Change user roles / permission groups.'),
  ('user.deactivate',         'Deactivate users',                    'security','Disable user access.'),
  ('po.create',               'Create purchase orders',              'purchasing','Raise a PO.'),
  ('po.approve',              'Approve purchase orders',             'purchasing','Sign off a PO.'),
  ('po.receive',              'Receive goods',                       'purchasing','Confirm goods receipt.')
ON CONFLICT DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('payroll.approve',  'payroll.create',            'critical','Maker-checker: payroll preparer must not also approve the same run.'),
  ('payroll.approve',  'payroll.execute',           'high',    'Approver of payroll should not also release payments.'),
  ('payroll.create',   'payroll.execute',           'high',    'Preparer of payroll should not also release payments.'),
  ('compensation.approve','compensation.modify',    'critical','Editor of salary / contract must not approve the change.'),
  ('compensation.modify','payroll.approve',         'high',    'Whoever modifies salary should not approve the payroll that pays it.'),
  ('loan.approve',     'loan.request',              'critical','Loan requester must not approve the same loan.'),
  ('loan.approve',     'loan.disburse',             'high',    'Loan approver should not also disburse funds.'),
  ('loan.disburse',    'loan.request',              'high',    'Loan requester should not disburse the same loan.'),
  ('leave.approve',    'leave.request',             'high',    'Leave requester must not approve their own leave.'),
  ('payment.approve',  'payment.create',            'critical','Payment preparer must not approve the same payment.'),
  ('payment.approve',  'payment.execute',           'high',    'Approver of payments should not also release the funds.'),
  ('payment.create',   'payment.execute',           'high',    'Preparer of payments should not also release funds.'),
  ('je.post',          'je.reverse',                'high',    'Whoever posts JEs should not unilaterally reverse them.'),
  ('vendor.create',    'vendor.pay',                'critical','Vendor master maintainer must not pay vendors (fraudulent vendor risk).'),
  ('payment.approve',  'vendor.create',             'high',    'Combining vendor master + payment approval enables fictitious-vendor fraud.'),
  ('inventory.adjust', 'inventory.approve_adjustment','critical','Adjustment creator must not approve their own write-off.'),
  ('bank.modify',      'payment.execute',           'critical','Whoever can change bank details should not also release payments.'),
  ('role.grant',       'user.deactivate',           'medium',  'One person should not single-handedly control account lifecycle.'),
  ('po.approve',       'po.create',                 'high',    'PO preparer must not approve the same PO.'),
  ('po.create',        'po.receive',                'high',    'PO creator should not also confirm goods receipt (phantom-receipt risk).'),
  ('po.approve',       'po.receive',                'medium',  'PO approver should not also confirm goods receipt.')
ON CONFLICT DO NOTHING;

INSERT INTO public.governance_duty_permission_map (duty_code, module, operation) VALUES
  ('payroll.create',              'payroll',   'write'),
  ('payroll.approve',             'payroll',   'approve'),
  ('payroll.execute',             'payroll',   'pay'),
  ('compensation.modify',         'employees', 'write'),
  ('compensation.approve',        'employees', 'approve'),
  ('loan.request',                'employees', 'create'),
  ('loan.approve',                'employees', 'approve'),
  ('loan.disburse',               'employees', 'pay'),
  ('leave.request',               'employees', 'create'),
  ('leave.approve',               'employees', 'approve'),
  ('payment.create',              'financials','create'),
  ('payment.approve',             'financials','approve'),
  ('payment.execute',             'financials','pay'),
  ('je.post',                     'financials','post'),
  ('je.reverse',                  'financials','delete'),
  ('vendor.create',               'contacts',  'write'),
  ('vendor.pay',                  'financials','pay'),
  ('refund.approve',              'sales',     'approve'),
  ('inventory.adjust',            'products',  'write'),
  ('inventory.approve_adjustment','products',  'approve'),
  ('bank.modify',                 'financials','write'),
  ('role.grant',                  'team',      'write'),
  ('user.deactivate',             'team',      'delete'),
  ('po.create',                   'purchases', 'create'),
  ('po.approve',                  'purchases', 'approve'),
  ('po.receive',                  'purchases', 'write')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.governance_user_duties(_user_id uuid, _org_id uuid)
RETURNS TABLE (duty_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.duty_code
  FROM public.governance_duties d
  WHERE EXISTS (SELECT 1 FROM public.governance_duty_permission_map m WHERE m.duty_code = d.duty_code)
    AND NOT EXISTS (
      SELECT 1 FROM public.governance_duty_permission_map m
      WHERE m.duty_code = d.duty_code
        AND NOT public.user_has_module_permission(_user_id, _org_id, m.module, m.operation)
    );
$$;
GRANT EXECUTE ON FUNCTION public.governance_user_duties(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.governance_sod_violations(_org_id uuid)
RETURNS TABLE (
  user_id     uuid,
  user_email  text,
  user_name   text,
  duty_a      text,
  duty_b      text,
  severity    text,
  rationale   text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH allowed AS (
    SELECT
      public.user_has_module_permission(auth.uid(), _org_id, 'team', 'read')
      OR public.has_role(auth.uid(), _org_id, 'owner'::app_role)
      OR public.has_role(auth.uid(), _org_id, 'admin'::app_role)
      OR public.has_role(auth.uid(), _org_id, 'super_admin'::app_role) AS ok
  ),
  org_users AS (
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur, allowed
    WHERE ur.organization_id = _org_id AND ur.is_active = true AND allowed.ok
  ),
  user_duties AS (
    SELECT u.user_id, d.duty_code
    FROM org_users u
    CROSS JOIN LATERAL public.governance_user_duties(u.user_id, _org_id) d
  )
  SELECT
    u.user_id,
    p.email,
    COALESCE(p.full_name, p.email),
    c.duty_a, c.duty_b, c.severity, c.rationale
  FROM public.governance_sod_conflicts c
  JOIN user_duties ua ON ua.duty_code = c.duty_a
  JOIN user_duties ub ON ub.duty_code = c.duty_b AND ub.user_id = ua.user_id
  JOIN org_users u    ON u.user_id   = ua.user_id
  LEFT JOIN public.profiles p ON p.id = u.user_id
  ORDER BY
    CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    u.user_id, c.duty_a, c.duty_b;
$$;
GRANT EXECUTE ON FUNCTION public.governance_sod_violations(uuid) TO authenticated;
