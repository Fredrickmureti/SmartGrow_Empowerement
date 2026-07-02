CREATE OR REPLACE FUNCTION public.enqueue_inventory_sms(
  _org_id uuid,
  _business_id uuid,
  _event sms_event_type,
  _product_id uuid,
  _product_name text,
  _sku text,
  _current_stock numeric,
  _reorder_level numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule RECORD;
  v_recipient RECORD;
  v_phone TEXT;
  v_vars JSONB;
  v_member RECORD;
  v_role_user RECORD;
  v_company_name TEXT;
  v_branch_name TEXT;
  v_severity TEXT;
BEGIN
  -- Prefer business-scoped rule, fall back to org default (business_id IS NULL)
  SELECT id, is_enabled, template_id, recipient_type
    INTO v_rule
    FROM public.sms_event_rules
   WHERE organization_id = _org_id
     AND event_type = _event
     AND (business_id IS NOT DISTINCT FROM _business_id OR business_id IS NULL)
   ORDER BY (business_id IS NOT DISTINCT FROM _business_id) DESC NULLS LAST
   LIMIT 1;

  IF NOT FOUND OR NOT COALESCE(v_rule.is_enabled, false) THEN
    RETURN;
  END IF;

  -- Org name
  SELECT COALESCE(name, '') INTO v_company_name
    FROM public.organizations WHERE id = _org_id;

  -- Branch / business name (optional)
  IF _business_id IS NOT NULL THEN
    SELECT COALESCE(name, '') INTO v_branch_name
      FROM public.businesses WHERE id = _business_id;
  ELSE
    v_branch_name := '';
  END IF;

  -- Derive a friendly severity for templates
  v_severity := CASE
    WHEN _event = 'out_of_stock'::sms_event_type THEN 'out_of_stock'
    WHEN COALESCE(_current_stock, 0) <= 0 THEN 'out_of_stock'
    WHEN COALESCE(_current_stock, 0) <= 1 THEN 'critical'
    ELSE 'warning'
  END;

  v_vars := jsonb_build_object(
    'product_name', COALESCE(_product_name, 'Unknown'),
    'sku', COALESCE(_sku, ''),
    'current_stock', COALESCE(_current_stock::text, '0'),
    'reorder_level', COALESCE(_reorder_level::text, '0'),
    'company_name', COALESCE(v_company_name, ''),
    'branch_name', COALESCE(v_branch_name, ''),
    'count', '1',
    'sample_products', COALESCE(_product_name, ''),
    'severity', v_severity
  );

  FOR v_recipient IN
    SELECT recipient_kind, phone, user_id, group_id, role
      FROM public.sms_event_rule_recipients
     WHERE rule_id = v_rule.id
  LOOP
    IF v_recipient.recipient_kind = 'phone' THEN
      v_phone := v_recipient.phone;
      IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
        INSERT INTO public.sms_event_outbox (
          organization_id, business_id, event_type, entity_type, entity_id,
          recipient_phone, template_variables, status, recipient_type
        ) VALUES (
          _org_id, _business_id, _event, 'product', _product_id,
          v_phone, v_vars, 'queued', 'internal'
        );
      END IF;
    ELSIF v_recipient.recipient_kind = 'user' AND v_recipient.user_id IS NOT NULL THEN
      SELECT phone INTO v_phone FROM public.profiles WHERE user_id = v_recipient.user_id LIMIT 1;
      IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
        INSERT INTO public.sms_event_outbox (
          organization_id, business_id, event_type, entity_type, entity_id,
          recipient_phone, template_variables, status, recipient_type
        ) VALUES (
          _org_id, _business_id, _event, 'product', _product_id,
          v_phone, v_vars, 'queued', 'internal'
        );
      END IF;
    ELSIF v_recipient.recipient_kind = 'group' AND v_recipient.group_id IS NOT NULL THEN
      FOR v_member IN
        SELECT member_kind, phone, user_id
          FROM public.sms_recipient_group_members
         WHERE group_id = v_recipient.group_id
      LOOP
        v_phone := NULL;
        IF v_member.member_kind = 'phone' THEN
          v_phone := v_member.phone;
        ELSIF v_member.member_kind = 'user' AND v_member.user_id IS NOT NULL THEN
          SELECT phone INTO v_phone FROM public.profiles WHERE user_id = v_member.user_id LIMIT 1;
        END IF;
        IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
          INSERT INTO public.sms_event_outbox (
            organization_id, business_id, event_type, entity_type, entity_id,
            recipient_phone, template_variables, status, recipient_type
          ) VALUES (
            _org_id, _business_id, _event, 'product', _product_id,
            v_phone, v_vars, 'queued', 'internal'
          );
        END IF;
      END LOOP;
    ELSIF v_recipient.recipient_kind = 'role' AND v_recipient.role IS NOT NULL THEN
      FOR v_role_user IN
        SELECT DISTINCT pr.phone
          FROM public.user_roles ur
          JOIN public.profiles pr ON pr.user_id = ur.user_id
         WHERE ur.organization_id = _org_id
           AND ur.role::text = v_recipient.role
           AND COALESCE(ur.is_active, true) = true
           AND pr.phone IS NOT NULL
           AND length(pr.phone) > 0
      LOOP
        INSERT INTO public.sms_event_outbox (
          organization_id, business_id, event_type, entity_type, entity_id,
          recipient_phone, template_variables, status, recipient_type
        ) VALUES (
          _org_id, _business_id, _event, 'product', _product_id,
          v_role_user.phone, v_vars, 'queued', 'internal'
        );
      END LOOP;
    END IF;
  END LOOP;
END;
$function$;