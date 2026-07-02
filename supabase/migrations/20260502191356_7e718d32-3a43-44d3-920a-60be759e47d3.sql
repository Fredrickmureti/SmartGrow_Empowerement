-- =============================================================
-- Stage 1+2+5: wire inventory stock changes into the SMS engine,
-- recover stuck outbox rows, align hourly cron with the full pipeline.
-- =============================================================

-- 1) Patch check_product_stock_and_notify so it also enqueues an SMS event
--    AFTER creating the in-app notification. The dedupe rule is unchanged:
--    use the existing notifications row as the rate limiter.
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
  v_sms_event sms_event_type;
  v_priority INTEGER;
  v_last_alert_at TIMESTAMPTZ;
  v_should_alert BOOLEAN;
  v_severity TEXT;
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
    v_sms_event := 'out_of_stock'::sms_event_type;
    v_priority := 2;
    v_severity := 'out_of_stock';
  ELSIF v_product.stock_quantity <= v_product.critical_threshold THEN
    v_notification_type := 'critical_stock';
    v_sms_event := 'low_stock_alert'::sms_event_type;
    v_priority := 1;
    v_severity := 'critical';
  ELSIF v_product.stock_quantity <= v_product.warning_threshold THEN
    v_notification_type := 'low_stock';
    v_sms_event := 'low_stock_alert'::sms_event_type;
    v_priority := 0;
    v_severity := 'warning';
  ELSE
    RETURN;
  END IF;

  -- Dedupe: use the most recent in-app notification of this type as the rate-limit anchor.
  SELECT MAX(n.created_at) INTO v_last_alert_at
    FROM notifications n
   WHERE n.entity_id = p_product_id
     AND n.entity_type = v_notification_type;

  IF v_last_alert_at IS NULL THEN
    v_should_alert := true;
  ELSIF v_last_alert_at < now() - interval '1 hour' THEN
    v_should_alert := true;
  ELSE
    -- Recovered then re-dropped (positive movement after last alert) -> alert again.
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

  -- In-app notifications (unchanged behavior)
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

  -- NEW: enqueue an SMS event (the flusher resolves recipients via sms_event_rules).
  -- The flusher will simply mark the row as "skipped: No recipient configured"
  -- if no rule/recipients exist, so this is safe even when SMS isn't set up.
  BEGIN
    INSERT INTO sms_event_outbox (
      organization_id, business_id, event_type, entity_type, entity_id,
      recipient_phone, recipient_contact_id, template_variables
    ) VALUES (
      v_product.organization_id, v_product.business_id, v_sms_event,
      'product', p_product_id, NULL, NULL,
      jsonb_build_object(
        'product_name', v_product.name,
        'sku',          COALESCE(v_product.sku, ''),
        'stock_quantity', v_product.stock_quantity::text,
        'reorder_level',  COALESCE(v_product.reorder_level, v_product.warning_threshold)::text,
        'severity',     v_severity
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let an SMS failure poison the in-app path.
    RAISE NOTICE '[check_product_stock_and_notify] sms_event_outbox insert failed: %', SQLERRM;
  END;
END;
$function$;

-- 2) Recovery RPC for outbox rows stuck in "processing" (no failure write happened).
CREATE OR REPLACE FUNCTION public.sms_outbox_recover_stuck(p_older_than_minutes int DEFAULT 10)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count int;
BEGIN
  WITH updated AS (
    UPDATE sms_event_outbox
       SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
           last_error = COALESCE(last_error, '') ||
                        CASE WHEN length(COALESCE(last_error,'')) > 0 THEN ' | ' ELSE '' END ||
                        'recovered from stuck processing',
           next_attempt_at = CASE WHEN attempts >= 3 THEN next_attempt_at ELSE now() END,
           processed_at = CASE WHEN attempts >= 3 THEN now() ELSE NULL END
     WHERE status = 'processing'
       AND COALESCE(processed_at, created_at) < now() - make_interval(mins => p_older_than_minutes)
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;
  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.sms_outbox_recover_stuck(int) TO authenticated, service_role;

-- 3) Immediate cleanup: free the 4 historically stuck rows so they retry now.
SELECT public.sms_outbox_recover_stuck(0);

-- 4) Cron alignment: the hourly job currently runs raw SQL which only emits in-app
--    notifications. Replace it with a call to the edge function so SMS + email
--    flow through the full pipeline. The 30-min job already does this, so the
--    hourly job becomes redundant — unschedule it cleanly.
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'check-low-stock-hourly';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;