-- ============================================================================
-- Fix inventory notification + SMS pipeline
-- Root causes:
--   1. enqueue_inventory_sms inserted status='pending' which violates the
--      sms_event_outbox CHECK (status IN queued/processing/sent/failed/skipped).
--      The error was swallowed by EXCEPTION WHEN OTHERS THEN NULL in the
--      caller, so no SMS was ever queued for low_stock / out_of_stock.
--   2. The 24h dedup window prevented a fresh alert after a replenishment
--      followed by a new depletion (e.g. adjust +30, sell 30 within same day).
--   3. Silent EXCEPTION block hid (1) for the entire SMS branch.
-- ============================================================================

-- 1) enqueue_inventory_sms: insert status='queued' (matches CHECK and flusher)
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
AS $function$
DECLARE
  v_rule RECORD;
  v_recipient RECORD;
  v_phone TEXT;
  v_vars JSONB;
  v_member RECORD;
  v_role_user RECORD;
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

-- 2) check_warehouse_stock_alerts: smarter dedup + visible errors.
--    Dedup rule: skip only if a same-type alert for this product/business
--    exists in the last hour AND no replenishment movement has occurred for
--    this product since that alert. This blocks rapid duplicates (within an
--    hour) but always re-alerts after a restock-then-deplete cycle.
CREATE OR REPLACE FUNCTION public.check_warehouse_stock_alerts(p_warehouse_stock_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_last_alert_at TIMESTAMPTZ;
  v_should_alert BOOLEAN;
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
      COALESCE(NULLIF(v_ws.reorder_level, 0), 0),
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

  -- Smart dedup: most-recent same-type alert for this product/business
  SELECT MAX(n.created_at) INTO v_last_alert_at
    FROM public.notifications n
   WHERE n.organization_id = v_ws.organization_id
     AND n.business_id IS NOT DISTINCT FROM v_ws.business_id
     AND n.entity_type = v_alert_type
     AND n.entity_id = v_ws.product_id;

  IF v_last_alert_at IS NULL THEN
    v_should_alert := true;
  ELSIF v_last_alert_at < now() - interval '1 hour' THEN
    -- Long enough gap: re-alert.
    v_should_alert := true;
  ELSE
    -- Recent alert: only re-alert if the product was replenished since then.
    v_should_alert := EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.product_id = v_ws.product_id
         AND sm.warehouse_id = v_ws.warehouse_id
         AND sm.created_at > v_last_alert_at
         AND sm.quantity > 0
    );
  END IF;

  IF v_should_alert THEN
    FOR v_user IN
      SELECT DISTINCT ur.user_id
        FROM public.user_roles ur
       WHERE ur.organization_id = v_ws.organization_id
         AND COALESCE(ur.is_active, true) = true
    LOOP
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
    END LOOP;

    -- SMS: surface failures via WARNING instead of swallowing silently.
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
      RAISE WARNING 'enqueue_inventory_sms failed for product=% event=%: % (%)',
        v_ws.product_id, v_sms_event, SQLERRM, SQLSTATE;
    END;
  END IF;
END;
$function$;

-- 3) Apply the same smart dedup to check_product_stock_and_notify
--    (the function fired by notify_low_stock_realtime on products.stock_quantity)
CREATE OR REPLACE FUNCTION public.check_product_stock_and_notify(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_product RECORD;
  v_user_id UUID;
  v_notification_type VARCHAR;
  v_priority INTEGER;
  v_last_alert_at TIMESTAMPTZ;
  v_should_alert BOOLEAN;
BEGIN
  SELECT 
    p.id, p.name, p.sku, p.organization_id, p.business_id,
    p.stock_quantity, p.reorder_level, p.is_active, p.track_inventory,
    COALESCE(nas.low_stock_warning_threshold, p.reorder_level, 10) AS warning_threshold,
    COALESCE(nas.low_stock_critical_threshold, GREATEST(1, COALESCE(p.reorder_level, 10) / 2), 5) AS critical_threshold,
    COALESCE(nas.out_of_stock_alert, true) AS out_of_stock_alert
  INTO v_product
  FROM products p
  LEFT JOIN notification_alert_settings nas 
    ON nas.organization_id = p.organization_id 
    AND (nas.business_id = p.business_id OR nas.business_id IS NULL)
  WHERE p.id = p_product_id
    AND p.is_active = true
    AND p.track_inventory = true;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_product.stock_quantity <= 0 AND v_product.out_of_stock_alert THEN
    v_notification_type := 'out_of_stock';
    v_priority := 2;
  ELSIF v_product.stock_quantity <= v_product.critical_threshold THEN
    v_notification_type := 'critical_stock';
    v_priority := 1;
  ELSIF v_product.stock_quantity <= v_product.warning_threshold THEN
    v_notification_type := 'low_stock';
    v_priority := 0;
  ELSE
    RETURN;
  END IF;

  SELECT MAX(n.created_at) INTO v_last_alert_at
    FROM notifications n
   WHERE n.entity_id = p_product_id
     AND n.entity_type = v_notification_type;

  IF v_last_alert_at IS NULL THEN
    v_should_alert := true;
  ELSIF v_last_alert_at < now() - interval '1 hour' THEN
    v_should_alert := true;
  ELSE
    v_should_alert := EXISTS (
      SELECT 1 FROM stock_movements sm
       WHERE sm.product_id = p_product_id
         AND sm.created_at > v_last_alert_at
         AND sm.quantity > 0
    );
  END IF;

  IF NOT v_should_alert THEN
    RETURN;
  END IF;

  FOR v_user_id IN 
    SELECT ur.user_id FROM user_roles ur
    WHERE ur.organization_id = v_product.organization_id 
      AND ur.is_active = true
      AND ur.role IN ('owner', 'admin', 'super_admin', 'staff')
  LOOP
    PERFORM create_notification(
      v_product.organization_id,
      v_user_id,
      CASE 
        WHEN v_notification_type = 'out_of_stock' THEN 'error'
        WHEN v_notification_type = 'critical_stock' THEN 'warning'
        ELSE 'info'
      END,
      'inventory',
      CASE 
        WHEN v_notification_type = 'out_of_stock' THEN 'Out of Stock!'
        WHEN v_notification_type = 'critical_stock' THEN 'Critical Stock Level'
        ELSE 'Low Stock Warning'
      END,
      'Product "' || v_product.name || '" (' || COALESCE(v_product.sku, 'No SKU') || ') ' ||
      CASE 
        WHEN v_notification_type = 'out_of_stock' THEN 'is now OUT OF STOCK'
        WHEN v_notification_type = 'critical_stock' THEN 'is at CRITICAL level: ' || v_product.stock_quantity || ' remaining'
        ELSE 'is running low: ' || v_product.stock_quantity || ' remaining (reorder at ' || COALESCE(v_product.reorder_level, v_product.warning_threshold) || ')'
      END,
      '/inventory',
      v_notification_type,
      p_product_id,
      v_priority,
      v_product.business_id
    );
  END LOOP;
END;
$function$;