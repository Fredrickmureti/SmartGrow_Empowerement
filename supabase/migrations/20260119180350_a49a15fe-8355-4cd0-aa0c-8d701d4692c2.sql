-- =====================================================
-- PHASE 1: Fix Critical Low Stock Notification System
-- =====================================================

-- 1. Create function to check a specific product and notify users
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
  v_warning_threshold INTEGER;
  v_critical_threshold INTEGER;
BEGIN
  -- Get product details
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

  -- Exit if product not found or not tracking inventory
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Determine notification type and priority based on stock level
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
    -- Stock is above thresholds, no notification needed
    RETURN;
  END IF;

  -- Check if we already sent this type of notification recently (within 24 hours)
  IF EXISTS (
    SELECT 1 FROM notifications n 
    WHERE n.entity_id = p_product_id 
      AND n.entity_type = v_notification_type
      AND n.created_at > NOW() - INTERVAL '24 hours'
  ) THEN
    RETURN;
  END IF;

  -- Notify all org members with inventory access
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
$$;

-- 2. Create the real-time trigger function for stock updates
CREATE OR REPLACE FUNCTION public.notify_low_stock_realtime()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only trigger when stock quantity actually decreases
  IF TG_OP = 'UPDATE' 
     AND OLD.stock_quantity IS DISTINCT FROM NEW.stock_quantity
     AND NEW.stock_quantity < OLD.stock_quantity
     AND NEW.track_inventory = true 
     AND NEW.is_active = true THEN
    
    -- Check this product's stock levels and notify if needed
    PERFORM check_product_stock_and_notify(NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- 3. Create the trigger on products table
DROP TRIGGER IF EXISTS trigger_low_stock_notification ON products;
CREATE TRIGGER trigger_low_stock_notification
  AFTER UPDATE OF stock_quantity ON products
  FOR EACH ROW
  EXECUTE FUNCTION notify_low_stock_realtime();

-- 4. Update the existing check_low_stock_products function to use thresholds
CREATE OR REPLACE FUNCTION public.check_low_stock_products()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Check all products that are below their configured thresholds
  FOR r IN 
    SELECT p.id
    FROM products p
    LEFT JOIN notification_alert_settings nas 
      ON nas.organization_id = p.organization_id 
      AND (nas.business_id = p.business_id OR nas.business_id IS NULL)
    WHERE p.track_inventory = true
      AND p.is_active = true
      AND (
        p.stock_quantity <= 0
        OR p.stock_quantity <= COALESCE(nas.low_stock_critical_threshold, GREATEST(1, COALESCE(p.reorder_level, 10) / 2), 5)
        OR p.stock_quantity <= COALESCE(nas.low_stock_warning_threshold, p.reorder_level, 10)
      )
  LOOP
    PERFORM check_product_stock_and_notify(r.id);
  END LOOP;
END;
$$;