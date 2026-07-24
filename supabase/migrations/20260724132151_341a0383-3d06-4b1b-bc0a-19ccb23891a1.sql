
CREATE OR REPLACE FUNCTION public._legal_order_publish_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, event_type,
      source_doc_type, source_doc_id, payload,
      status, idempotency_key, actor_user_id
    ) VALUES (
      NEW.organization_id,
      NULL,
      'legal_order.status_changed',
      'legal_order',
      NEW.id,
      jsonb_build_object(
        'legal_order_id', NEW.id,
        'garnishment_id', NEW.id,
        'organization_id', NEW.organization_id,
        'business_id',    NEW.business_id,
        'employee_id',    NEW.employee_id,
        'recipient_id',   NEW.recipient_id,
        'from_status',    OLD.status,
        'to_status',      NEW.status,
        'status_reason',  NEW.status_reason,
        'changed_at',     NEW.status_changed_at,
        'changed_by',     NEW.status_changed_by
      ),
      'pending',
      'legal_order.status_changed:' || NEW.id::text || ':'
        || COALESCE(NEW.status_changed_at::text, now()::text)
        || ':' || COALESCE(OLD.status::text, 'null') || '>' || NEW.status::text,
      NEW.status_changed_by
    )
    ON CONFLICT (org_id, idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._legal_order_publish_status_event() IS
  'ADR-0094 Phase 5: emits legal_order.status_changed into business_event_outbox for every accepted transition using the correct outbox schema.';

CREATE TABLE IF NOT EXISTS public.legal_order_subscriber_dispatch_log (
  source_event_id uuid       NOT NULL,
  subscriber      text       NOT NULL,
  organization_id uuid       NOT NULL,
  topic           text       NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  outcome         text       NOT NULL DEFAULT 'ok',
  details         jsonb      NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_event_id, subscriber)
);

GRANT SELECT ON public.legal_order_subscriber_dispatch_log TO authenticated;
GRANT ALL    ON public.legal_order_subscriber_dispatch_log TO service_role;
ALTER TABLE public.legal_order_subscriber_dispatch_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_order_subscriber_log_read ON public.legal_order_subscriber_dispatch_log;
CREATE POLICY legal_order_subscriber_log_read
  ON public.legal_order_subscriber_dispatch_log FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE OR REPLACE FUNCTION public.legal_order_check_finance_drift(
  p_event_id  uuid,
  p_org_id    uuid,
  p_business  uuid,
  p_topic     text,
  p_payload   jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient_id uuid;
  v_view_row     RECORD;
  v_accrued      numeric := 0;
  v_paid         numeric := 0;
  v_drift        numeric := 0;
  v_over_remit   boolean := false;
  v_issue_id     uuid;
  v_tolerance    numeric := 0.01;
  v_already      boolean;
BEGIN
  SELECT true INTO v_already
    FROM public.legal_order_subscriber_dispatch_log
   WHERE source_event_id = p_event_id
     AND subscriber      = 'finance.drift_checker';
  IF v_already THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_dispatched');
  END IF;

  v_recipient_id := NULLIF(p_payload->>'recipient_id','')::uuid;
  IF v_recipient_id IS NULL THEN
    SELECT recipient_id INTO v_recipient_id
      FROM public.legal_orders_records
     WHERE id = COALESCE(
       NULLIF(p_payload->>'legal_order_id','')::uuid,
       NULLIF(p_payload->>'garnishment_id','')::uuid
     );
  END IF;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.legal_order_subscriber_dispatch_log
      (source_event_id, subscriber, organization_id, topic, outcome, details)
    VALUES (p_event_id, 'finance.drift_checker', p_org_id, p_topic, 'noop',
      jsonb_build_object('reason', 'no_recipient'))
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_recipient');
  END IF;

  SELECT * INTO v_view_row
    FROM public.legal_recipient_outstanding
   WHERE recipient_id = v_recipient_id
     AND organization_id = p_org_id;

  SELECT COALESCE(SUM(l.amount), 0)
    INTO v_accrued
    FROM public.garnishment_ledger l
    JOIN public.legal_orders_records g ON g.id = l.garnishment_id
   WHERE g.recipient_id = v_recipient_id
     AND g.organization_id = p_org_id;

  SELECT COALESCE(SUM(r.amount), 0)
    INTO v_paid
    FROM public.legal_order_remittance_lines r
    JOIN public.legal_orders_records g ON g.id = r.garnishment_id
   WHERE g.recipient_id = v_recipient_id
     AND g.organization_id = p_org_id;

  v_over_remit := v_paid > (v_accrued + v_tolerance);

  IF v_view_row.recipient_id IS NOT NULL THEN
    v_drift := GREATEST(
      abs(COALESCE(v_view_row.accrued_total, 0) - v_accrued),
      abs(COALESCE(v_view_row.paid_total,    0) - v_paid)
    );
  END IF;

  IF v_over_remit OR v_drift > v_tolerance THEN
    INSERT INTO public.finance_integrity_issues (
      organization_id, business_id, issue_code, severity,
      source_type, source_id, details, detected_at
    ) VALUES (
      p_org_id,
      p_business,
      CASE
        WHEN v_over_remit THEN 'legal_order.recipient_over_remit'
        ELSE 'legal_order.recipient_rollup_drift'
      END,
      CASE WHEN v_over_remit THEN 'error' ELSE 'warning' END,
      'legal_recipient',
      v_recipient_id,
      jsonb_build_object(
        'source_event_id', p_event_id,
        'topic',           p_topic,
        'recipient_id',    v_recipient_id,
        'view_accrued',    COALESCE(v_view_row.accrued_total, 0),
        'view_paid',       COALESCE(v_view_row.paid_total, 0),
        'live_accrued',    v_accrued,
        'live_paid',       v_paid,
        'drift',           v_drift,
        'over_remit',      v_over_remit
      ),
      now()
    ) RETURNING id INTO v_issue_id;
  END IF;

  INSERT INTO public.legal_order_subscriber_dispatch_log
    (source_event_id, subscriber, organization_id, topic, outcome, details)
  VALUES (
    p_event_id, 'finance.drift_checker', p_org_id, p_topic,
    CASE WHEN v_issue_id IS NULL THEN 'ok' ELSE 'issue_opened' END,
    jsonb_build_object(
      'recipient_id', v_recipient_id,
      'issue_id',     v_issue_id,
      'drift',        v_drift,
      'over_remit',   v_over_remit
    )
  )
  ON CONFLICT (source_event_id, subscriber) DO NOTHING;

  RETURN jsonb_build_object(
    'issue_id', v_issue_id, 'drift', v_drift, 'over_remit', v_over_remit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_check_finance_drift(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_check_finance_drift(uuid, uuid, uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.legal_order_notify_employee(
  p_event_id  uuid,
  p_org_id    uuid,
  p_business  uuid,
  p_topic     text,
  p_payload   jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_already   boolean;
  v_emp_id    uuid;
  v_user_id   uuid;
  v_order_id  uuid;
  v_to_status text;
  v_title     text;
  v_message   text;
  v_notify    boolean := false;
  v_amount    numeric;
BEGIN
  SELECT true INTO v_already
    FROM public.legal_order_subscriber_dispatch_log
   WHERE source_event_id = p_event_id
     AND subscriber      = 'ess.employee_notifier';
  IF v_already THEN RETURN 0; END IF;

  v_emp_id   := NULLIF(p_payload->>'employee_id','')::uuid;
  v_order_id := COALESCE(
                  NULLIF(p_payload->>'legal_order_id','')::uuid,
                  NULLIF(p_payload->>'garnishment_id','')::uuid
                );
  IF v_emp_id IS NULL AND v_order_id IS NOT NULL THEN
    SELECT employee_id INTO v_emp_id
      FROM public.legal_orders_records WHERE id = v_order_id;
  END IF;

  IF v_emp_id IS NOT NULL THEN
    SELECT user_id INTO v_user_id
      FROM public.employees WHERE id = v_emp_id;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.legal_order_subscriber_dispatch_log
      (source_event_id, subscriber, organization_id, topic, outcome, details)
    VALUES (p_event_id, 'ess.employee_notifier', p_org_id, p_topic, 'noop',
      jsonb_build_object('reason', 'no_user', 'employee_id', v_emp_id))
    ON CONFLICT DO NOTHING;
    RETURN 0;
  END IF;

  v_to_status := p_payload->>'to_status';
  IF p_topic = 'legal_order.status_changed' THEN
    v_notify := v_to_status IN ('active','suspended','satisfied','released');
    v_title := CASE v_to_status
      WHEN 'active'    THEN 'A legal order on your payroll is now active'
      WHEN 'suspended' THEN 'A legal order on your payroll has been suspended'
      WHEN 'satisfied' THEN 'A legal order on your payroll has been satisfied'
      WHEN 'released'  THEN 'A legal order on your payroll has been released'
      ELSE 'Legal order status update'
    END;
    v_message := COALESCE(
      NULLIF(p_payload->>'status_reason',''),
      'View your legal orders for details.'
    );
  ELSIF p_topic = 'legal_order.payment_posted' THEN
    v_notify := true;
    v_amount := COALESCE((p_payload->>'amount')::numeric, 0);
    v_title  := 'A garnishment payment was sent from your payroll';
    v_message := 'Amount ' || to_char(v_amount, 'FM999,999,990.00')
              || COALESCE(' · Ref ' || NULLIF(p_payload->>'reference_number',''), '');
  END IF;

  IF NOT v_notify THEN
    INSERT INTO public.legal_order_subscriber_dispatch_log
      (source_event_id, subscriber, organization_id, topic, outcome, details)
    VALUES (p_event_id, 'ess.employee_notifier', p_org_id, p_topic, 'skipped',
      jsonb_build_object('reason', 'topic_not_ess_relevant', 'to_status', v_to_status))
    ON CONFLICT DO NOTHING;
    RETURN 0;
  END IF;

  PERFORM public.create_notification(
    p_org_id, v_user_id, 'info', 'payroll',
    v_title, v_message,
    '/me/legal-orders',
    'legal_order', v_order_id,
    CASE WHEN v_to_status IN ('suspended','satisfied','released') THEN 1 ELSE 0 END,
    p_business
  );

  INSERT INTO public.legal_order_subscriber_dispatch_log
    (source_event_id, subscriber, organization_id, topic, outcome, details)
  VALUES (p_event_id, 'ess.employee_notifier', p_org_id, p_topic, 'ok',
    jsonb_build_object('user_id', v_user_id, 'legal_order_id', v_order_id))
  ON CONFLICT DO NOTHING;

  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_notify_employee(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_notify_employee(uuid, uuid, uuid, text, jsonb) TO service_role;

INSERT INTO public.business_event_subscriptions
  (event_type, subscriber_name, handler_function, consumer_domain)
VALUES
  ('legal_order.status_changed', 'finance.drift_checker',
    'public.legal_order_check_finance_drift(uuid,uuid,uuid,text,jsonb)', 'finance'),
  ('legal_order.status_changed', 'ess.employee_notifier',
    'public.legal_order_notify_employee(uuid,uuid,uuid,text,jsonb)', 'ess'),
  ('legal_order.payment_posted', 'finance.drift_checker',
    'public.legal_order_check_finance_drift(uuid,uuid,uuid,text,jsonb)', 'finance'),
  ('legal_order.payment_posted', 'ess.employee_notifier',
    'public.legal_order_notify_employee(uuid,uuid,uuid,text,jsonb)', 'ess')
ON CONFLICT (event_type, subscriber_name) DO UPDATE
  SET handler_function = EXCLUDED.handler_function,
      consumer_domain  = EXCLUDED.consumer_domain,
      is_active        = true;
