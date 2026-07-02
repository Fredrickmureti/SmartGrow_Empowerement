
-- ============================================================
-- Stage B: Fix enqueue_inventory_sms to respect business_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_inventory_sms(
  _org_id uuid, _business_id uuid, _event sms_event_type,
  _product_id uuid, _product_name text, _sku text,
  _current_stock numeric, _reorder_level numeric
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

-- ============================================================
-- Stage B: notification_alert_settings unique key safe for NULL business_id
-- ============================================================
DO $$ BEGIN
  -- Drop any existing duplicates first (keep oldest)
  DELETE FROM public.notification_alert_settings a
   USING public.notification_alert_settings b
   WHERE a.id > b.id
     AND a.organization_id = b.organization_id
     AND a.business_id IS NOT DISTINCT FROM b.business_id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS notification_alert_settings_org_bus_uq
    ON public.notification_alert_settings (organization_id, business_id)
    WHERE business_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS notification_alert_settings_org_default_uq
    ON public.notification_alert_settings (organization_id)
    WHERE business_id IS NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ============================================================
-- Stage B + C: Attach orphan triggers
-- ============================================================

-- products: low-stock realtime check
DROP TRIGGER IF EXISTS trg_notify_low_stock_realtime ON public.products;
CREATE TRIGGER trg_notify_low_stock_realtime
AFTER UPDATE OF stock_quantity ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.notify_low_stock_realtime();

-- stock_movements: warehouse stock alerts
DROP TRIGGER IF EXISTS trg_check_warehouse_stock_alerts ON public.stock_movements;
CREATE TRIGGER trg_check_warehouse_stock_alerts
AFTER INSERT ON public.stock_movements
FOR EACH ROW
EXECUTE FUNCTION public.trg_check_warehouse_stock_alerts();

-- payments: in-app notification on receive
DROP TRIGGER IF EXISTS trg_notify_payment_received ON public.payments;
CREATE TRIGGER trg_notify_payment_received
AFTER INSERT ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.notify_payment_received();

-- invoices: in-app notification on create
DROP TRIGGER IF EXISTS trg_notify_invoice_created ON public.invoices;
CREATE TRIGGER trg_notify_invoice_created
AFTER INSERT ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.notify_invoice_created();

-- expenses: in-app notification on create
DROP TRIGGER IF EXISTS trg_notify_expense_created ON public.expenses;
CREATE TRIGGER trg_notify_expense_created
AFTER INSERT ON public.expenses
FOR EACH ROW
EXECUTE FUNCTION public.notify_expense_created();

-- user_roles: notify team on new member
DROP TRIGGER IF EXISTS trg_notify_new_team_member ON public.user_roles;
CREATE TRIGGER trg_notify_new_team_member
AFTER INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.notify_new_team_member();

-- ============================================================
-- Stage F: Schedule check-inventory-alerts and speed up SMS flusher
-- ============================================================
DO $$
DECLARE
  v_anon_key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
  v_func_url TEXT := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/check-inventory-alerts';
  v_existing_id BIGINT;
BEGIN
  -- check-inventory-alerts every 30 min
  SELECT jobid INTO v_existing_id FROM cron.job WHERE jobname = 'check-inventory-alerts-30min';
  IF v_existing_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_id);
  END IF;

  PERFORM cron.schedule(
    'check-inventory-alerts-30min',
    '*/30 * * * *',
    format($cron$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || %L,'apikey', %L),
        body := '{}'::jsonb
      );
    $cron$, v_func_url, v_anon_key, v_anon_key)
  );

  -- Speed up process-scheduled-automations from */15 to */2 (it runs flushSmsOutbox)
  SELECT jobid INTO v_existing_id FROM cron.job WHERE jobname = 'process-scheduled-automations';
  IF v_existing_id IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := v_existing_id, schedule := '*/2 * * * *');
  END IF;
END $$;
