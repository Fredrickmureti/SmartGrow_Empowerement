-- Fix 1: Stop phantom out-of-stock notification when warehouse_stock row is
-- first inserted at default quantity=0 (the natural pre-state of the
-- opening-stock workflow). Real OOS transitions still fire via the UPDATE
-- branch when quantity drops to zero.
CREATE OR REPLACE FUNCTION public.trg_check_warehouse_stock_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only alert on insert if the row is created already in a stocked
    -- state. A fresh 0-qty row is the natural pre-state of any
    -- opening-stock / warehouse-provisioning workflow and must NOT
    -- generate an out-of-stock notification.
    IF COALESCE(NEW.quantity, 0) > 0 THEN
      BEGIN
        PERFORM public.check_warehouse_stock_alerts(NEW.id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[trg_check_warehouse_stock_alerts] suppressed % (%): %',
          SQLERRM, SQLSTATE, NEW.id;
      END;
    END IF;
  ELSIF COALESCE(NEW.quantity, 0) IS DISTINCT FROM COALESCE(OLD.quantity, 0) THEN
    BEGIN
      PERFORM public.check_warehouse_stock_alerts(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[trg_check_warehouse_stock_alerts] suppressed % (%): %',
        SQLERRM, SQLSTATE, NEW.id;
    END;
  END IF;
  RETURN NEW;
END;
$function$;

-- Fix 2a: route OOS / low-stock notifications to a real page (/inventory-app/stock)
-- in check_warehouse_stock_alerts.
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

  SELECT MAX(n.created_at) INTO v_last_alert_at
    FROM public.notifications n
   WHERE n.organization_id = v_ws.organization_id
     AND n.business_id IS NOT DISTINCT FROM v_ws.business_id
     AND n.entity_type = v_alert_type
     AND n.entity_id = v_ws.product_id;

  IF v_last_alert_at IS NULL THEN
    v_should_alert := true;
  ELSIF v_last_alert_at < now() - interval '1 hour' THEN
    v_should_alert := true;
  ELSE
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
        '/inventory-app/stock',
        v_alert_type,
        v_ws.product_id,
        v_priority,
        v_ws.business_id
      );
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
      RAISE WARNING 'enqueue_inventory_sms failed for product=% event=%: % (%)',
        v_ws.product_id, v_sms_event, SQLERRM, SQLSTATE;
    END;
  END IF;
END;
$function$;

-- Fix 2b: same link correction in the product-level helper used by the
-- products.stock_quantity decrease trigger and the cron.
CREATE OR REPLACE FUNCTION public.check_product_stock_and_notify(p_product_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_product RECORD;
  v_user_id UUID;
  v_notification_type VARCHAR;
  v_priority INTEGER;
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

  IF EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.entity_id = p_product_id
      AND n.entity_type = v_notification_type
      AND n.created_at > NOW() - INTERVAL '24 hours'
  ) THEN
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
      '/inventory-app/stock',
      v_notification_type,
      p_product_id,
      v_priority,
      v_product.business_id
    );
  END LOOP;
END;
$$;

-- Fix 4: back-fill stale inventory notifications so existing links stop 404-ing.
UPDATE public.notifications
   SET link = '/inventory-app/stock'
 WHERE category = 'inventory'
   AND link = '/inventory';