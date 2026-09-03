-- 1. Drop ERP-only SoD conflicts and duties
DELETE FROM public.governance_sod_conflicts
WHERE split_part(duty_a,'.',1) IN ('asn','po','grn','goods_receipt','bill','credit','compensation','payroll','contract','inventory','leave','vendor','requisition','sourcing','supplier_terms')
   OR split_part(duty_b,'.',1) IN ('asn','po','grn','goods_receipt','bill','credit','compensation','payroll','contract','inventory','leave','vendor','requisition','sourcing','supplier_terms');

DELETE FROM public.governance_duty_permission_map
WHERE split_part(duty_code,'.',1) IN ('asn','po','grn','goods_receipt','bill','credit','compensation','payroll','contract','inventory','leave','vendor','requisition','sourcing','supplier_terms');

DELETE FROM public.governance_duties
WHERE split_part(duty_code,'.',1) IN ('asn','po','grn','goods_receipt','bill','credit','compensation','payroll','contract','inventory','leave','vendor','requisition','sourcing','supplier_terms');

-- 2. Remap loan duties to the Lending module
DELETE FROM public.governance_duty_permission_map WHERE duty_code LIKE 'loan.%';
INSERT INTO public.governance_duty_permission_map (duty_code, module, operation) VALUES
  ('loan.request',   'lending', 'create'),
  ('loan.originate', 'lending', 'write'),
  ('loan.approve',   'lending', 'approve'),
  ('loan.disburse',  'lending', 'pay'),
  ('loan.write_off', 'lending', 'write');

UPDATE public.governance_duties SET domain = 'lending',
  label = CASE duty_code
    WHEN 'loan.request'   THEN 'Capture loan application'
    WHEN 'loan.originate' THEN 'Assess / originate loan'
    WHEN 'loan.approve'   THEN 'Approve loan'
    WHEN 'loan.disburse'  THEN 'Disburse loan'
    WHEN 'loan.write_off' THEN 'Write off / restructure loan'
    ELSE label END
WHERE duty_code LIKE 'loan.%';

-- 3. Honour pay/close/reverse group flags in permission resolution
CREATE OR REPLACE FUNCTION public.user_has_module_permission(_user_id uuid, _org_id uuid, _module text, _operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
  _mod text := CASE
    WHEN _module = 'hr'         THEN 'employees'
    WHEN _module = 'timesheets' THEN 'attendance'
    ELSE _module
  END;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('super_admin', 'owner', 'admin') THEN RETURN true; END IF;

  IF _operation IN ('read','create','write','delete') THEN
    _base_grants := (
      CASE
        WHEN _mod = 'contacts' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
        WHEN _mod = 'contacts' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
        WHEN _mod = 'financials' AND _operation IN ('read','create','write','delete') THEN _role IN ('accountant','internal')
        WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal','accountant')
        WHEN _mod = 'team' AND _operation = 'read' THEN _role IN ('internal','accountant')
        ELSE false
      END
    );
    IF _user_type = 'portal' THEN _base_grants := false; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND pgr.module = _mod
      AND CASE _operation
        WHEN 'read'    THEN pgr.can_read
        WHEN 'create'  THEN pgr.can_create
        WHEN 'write'   THEN pgr.can_write
        WHEN 'delete'  THEN pgr.can_delete
        WHEN 'approve' THEN pgr.can_approve
        WHEN 'post'    THEN pgr.can_post
        WHEN 'pay'     THEN pgr.can_pay
        WHEN 'close'   THEN pgr.can_close
        WHEN 'reverse' THEN pgr.can_reverse
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;