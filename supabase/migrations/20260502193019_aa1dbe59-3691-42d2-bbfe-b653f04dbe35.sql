
-- =============================================================
-- Real-time email channel + small SMS engine fixes
-- =============================================================

-- 1) email_event_outbox: queue table for automatic email events
CREATE TABLE IF NOT EXISTS public.email_event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  recipient_email TEXT,           -- explicit override; otherwise resolver fans out
  recipient_user_id UUID,
  template_variables JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','sent','failed','skipped')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_event_outbox_pending
  ON public.email_event_outbox (next_attempt_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_email_event_outbox_org
  ON public.email_event_outbox (organization_id, created_at DESC);

ALTER TABLE public.email_event_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can view email outbox" ON public.email_event_outbox;
CREATE POLICY "Org admins can view email outbox"
ON public.email_event_outbox
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = email_event_outbox.organization_id
      AND ur.is_active = true
      AND ur.role IN ('owner','admin','super_admin')
  )
);

-- Service role bypasses RLS; no INSERT/UPDATE policies needed for end users.

-- 2) Recovery RPC for stuck rows
CREATE OR REPLACE FUNCTION public.email_outbox_recover_stuck(p_older_than_minutes int DEFAULT 10)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int;
BEGIN
  WITH updated AS (
    UPDATE email_event_outbox
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
$$;

GRANT EXECUTE ON FUNCTION public.email_outbox_recover_stuck(int) TO authenticated, service_role;

-- 3) Patch check_product_stock_and_notify:
--    - Shorten out_of_stock dedupe to 5 minutes
--    - Enqueue an email row alongside the SMS row
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
  v_dedupe_window INTERVAL;
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

  IF NOT FOUND THEN RETURN; END IF;

  IF v_product.stock_quantity <= 0 AND v_product.out_of_stock_alert THEN
    v_notification_type := 'out_of_stock';
    v_sms_event := 'out_of_stock'::sms_event_type;
    v_priority := 2;
    v_severity := 'out_of_stock';
    v_dedupe_window := interval '5 minutes';
  ELSIF v_product.stock_quantity <= v_product.critical_threshold THEN
    v_notification_type := 'critical_stock';
    v_sms_event := 'low_stock_alert'::sms_event_type;
    v_priority := 1;
    v_severity := 'critical';
    v_dedupe_window := interval '1 hour';
  ELSIF v_product.stock_quantity <= v_product.warning_threshold THEN
    v_notification_type := 'low_stock';
    v_sms_event := 'low_stock_alert'::sms_event_type;
    v_priority := 0;
    v_severity := 'warning';
    v_dedupe_window := interval '1 hour';
  ELSE
    RETURN;
  END IF;

  SELECT MAX(n.created_at) INTO v_last_alert_at
    FROM notifications n
   WHERE n.entity_id = p_product_id
     AND n.entity_type = v_notification_type;

  IF v_last_alert_at IS NULL THEN
    v_should_alert := true;
  ELSIF v_last_alert_at < now() - v_dedupe_window THEN
    v_should_alert := true;
  ELSE
    v_should_alert := EXISTS (
      SELECT 1 FROM stock_movements sm
       WHERE sm.product_id = p_product_id
         AND sm.created_at > v_last_alert_at
         AND sm.quantity > 0
    );
  END IF;

  IF NOT v_should_alert THEN RETURN; END IF;

  -- In-app notifications (unchanged)
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

  -- SMS enqueue (unchanged behavior; isolated failure)
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
    RAISE NOTICE '[check_product_stock_and_notify] sms_event_outbox insert failed: %', SQLERRM;
  END;

  -- NEW: Email enqueue (also isolated failure)
  BEGIN
    INSERT INTO email_event_outbox (
      organization_id, business_id, event_type, entity_type, entity_id,
      recipient_email, template_variables
    ) VALUES (
      v_product.organization_id, v_product.business_id,
      CASE
        WHEN v_notification_type = 'out_of_stock' THEN 'out_of_stock'
        ELSE 'low_stock_alert'
      END,
      'product', p_product_id, NULL,
      jsonb_build_object(
        'product_name',   v_product.name,
        'sku',            COALESCE(v_product.sku, ''),
        'stock_quantity', v_product.stock_quantity::text,
        'reorder_level',  COALESCE(v_product.reorder_level, v_product.warning_threshold)::text,
        'severity',       v_severity,
        'notification_type', v_notification_type
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[check_product_stock_and_notify] email_event_outbox insert failed: %', SQLERRM;
  END;
END;
$function$;

-- 4) Drop duplicate trigger on products
DROP TRIGGER IF EXISTS trigger_low_stock_notification ON public.products;

-- 5) Backfill: ensure the existing low_stock_alert rule has at least one recipient
--    (use the same phone that already works for out_of_stock on this org)
INSERT INTO public.sms_event_rule_recipients (rule_id, recipient_kind, phone, is_fallback)
SELECT r.id, 'phone', '+18777804236', true
FROM public.sms_event_rules r
WHERE r.event_type = 'low_stock_alert'
  AND r.organization_id = '81695269-0f41-4aec-8f49-2fa6d11946b2'
  AND NOT EXISTS (
    SELECT 1 FROM public.sms_event_rule_recipients rr WHERE rr.rule_id = r.id
  );
