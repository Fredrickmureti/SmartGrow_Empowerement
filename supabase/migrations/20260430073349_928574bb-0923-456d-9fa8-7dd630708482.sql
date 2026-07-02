CREATE OR REPLACE FUNCTION public.enqueue_inventory_sms(
  _org_id uuid,
  _business_id uuid,
  _event public.sms_event_type,
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
AS $$
DECLARE
  v_rule RECORD;
  v_recipient RECORD;
  v_phone TEXT;
  v_vars JSONB;
BEGIN
  SELECT id, is_enabled, template_id, recipient_type
    INTO v_rule
    FROM public.sms_event_rules
   WHERE organization_id = _org_id
     AND event_type = _event
   LIMIT 1;

  IF NOT FOUND OR NOT COALESCE(v_rule.is_enabled, false) THEN
    RETURN;
  END IF;

  v_vars := jsonb_build_object(
    'product_name', COALESCE(_product_name, 'Unknown'),
    'sku', COALESCE(_sku, ''),
    'current_stock', COALESCE(_current_stock::text, '0'),
    'reorder_level', COALESCE(_reorder_level::text, '0')
  );

  FOR v_recipient IN
    SELECT recipient_kind, phone, user_id
      FROM public.sms_event_rule_recipients
     WHERE rule_id = v_rule.id
  LOOP
    v_phone := NULL;
    IF v_recipient.recipient_kind = 'phone' THEN
      v_phone := v_recipient.phone;
    ELSIF v_recipient.recipient_kind = 'user' AND v_recipient.user_id IS NOT NULL THEN
      SELECT phone INTO v_phone FROM public.profiles WHERE user_id = v_recipient.user_id LIMIT 1;
    END IF;

    IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
      INSERT INTO public.sms_event_outbox (
        organization_id, business_id, event_type, entity_type, entity_id,
        recipient_phone, template_variables, status, recipient_type
      ) VALUES (
        _org_id, _business_id, _event, 'product', _product_id,
        v_phone, v_vars, 'pending', 'internal'
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_warehouse_stock_alerts(p_warehouse_stock_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ws RECORD;
  v_product RECORD;
  v_settings RECORD;
  v_alert_type TEXT;
  v_title TEXT;
  v_priority INT;
  v_message TEXT;
  v_threshold NUMERIC := 0;
  v_user RECORD;
  v_sms_event public.sms_event_type;
BEGIN
  SELECT ws.*, w.name AS warehouse_name, w.business_id
    INTO v_ws
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
   WHERE ws.id = p_warehouse_stock_id;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_product FROM public.products WHERE id = v_ws.product_id;

  IF NOT FOUND OR COALESCE(v_product.track_inventory, true) = false OR COALESCE(v_product.is_active, true) = false THEN
    RETURN;
  END IF;

  SELECT * INTO v_settings
    FROM public.notification_alert_settings nas
   WHERE nas.organization_id = v_ws.organization_id
     AND (nas.business_id = v_ws.business_id OR nas.business_id IS NULL)
   ORDER BY nas.business_id NULLS LAST
   LIMIT 1;

  IF v_ws.quantity <= 0 AND COALESCE(v_settings.out_of_stock_alert, true) THEN
    v_alert_type := 'out_of_stock';
    v_sms_event := 'out_of_stock';
    v_title := 'Out of Stock!';
    v_priority := 2;
    v_message := 'Product "' || COALESCE(v_product.name, 'Unknown product') || '" (' || COALESCE(v_product.sku, 'No SKU') || ') is now OUT OF STOCK in ' || COALESCE(v_ws.warehouse_name, 'the selected warehouse');
  ELSE
    v_threshold := GREATEST(
      COALESCE(NULLIF(v_ws.ws_reorder_level, 0), 0),
      COALESCE(NULLIF(v_product.reorder_level, 0), 0),
      COALESCE(v_settings.low_stock_warning_threshold, 10)
    );

    IF v_threshold > 0 AND v_ws.quantity <= v_threshold THEN
      v_alert_type := 'low_stock';
      v_sms_event := 'low_stock_alert';
      v_title := 'Low Stock Alert';
      v_priority := 1;
      v_message := 'Product "' || COALESCE(v_product.name, 'Unknown product') || '" (' || COALESCE(v_product.sku, 'No SKU') || ') is below reorder level in ' || COALESCE(v_ws.warehouse_name, 'the selected warehouse') || '. Current: ' || v_ws.quantity || ', Reorder at: ' || v_threshold;
    ELSE
      RETURN;
    END IF;
  END IF;

  FOR v_user IN
    SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
     WHERE ur.organization_id = v_ws.organization_id
       AND COALESCE(ur.is_active, true) = true
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM public.notifications n
       WHERE n.organization_id = v_ws.organization_id
         AND n.business_id IS NOT DISTINCT FROM v_ws.business_id
         AND n.user_id = v_user.user_id
         AND n.entity_type = v_alert_type
         AND n.entity_id = v_ws.product_id
         AND n.created_at > now() - interval '24 hours'
    ) THEN
      PERFORM public.create_notification(
        v_ws.organization_id,
        v_user.user_id,
        CASE WHEN v_alert_type = 'out_of_stock' THEN 'error' ELSE 'warning' END,
        'inventory',
        v_title,
        v_message,
        '/inventory',
        v_alert_type,
        v_ws.product_id,
        v_priority,
        v_ws.business_id
      );
    END IF;
  END LOOP;

  BEGIN
    PERFORM public.enqueue_inventory_sms(
      v_ws.organization_id,
      v_ws.business_id,
      v_sms_event,
      v_ws.product_id,
      v_product.name,
      v_product.sku,
      v_ws.quantity,
      v_threshold
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;