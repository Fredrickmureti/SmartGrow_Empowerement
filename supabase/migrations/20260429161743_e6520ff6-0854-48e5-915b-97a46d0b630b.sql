
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS sms_consent boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_consent_recorded_at timestamptz;

ALTER TABLE public.sms_provider_configs
  ADD COLUMN IF NOT EXISTS sms_compliance_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_compliance_acknowledged_by uuid;

ALTER TABLE public.sms_event_outbox
  ADD COLUMN IF NOT EXISTS recipient_type text,
  ADD COLUMN IF NOT EXISTS recipient_employee_id uuid,
  ADD COLUMN IF NOT EXISTS recipient_vendor_id uuid;

CREATE INDEX IF NOT EXISTS idx_sms_outbox_status_next
  ON public.sms_event_outbox (status, next_attempt_at)
  WHERE status IN ('queued','processing');

CREATE OR REPLACE FUNCTION public.enqueue_sms_event(
  p_organization_id uuid,
  p_business_id uuid,
  p_event_type sms_event_type,
  p_entity_type text,
  p_entity_id uuid,
  p_template_variables jsonb DEFAULT '{}'::jsonb,
  p_recipient_type text DEFAULT NULL,
  p_recipient_contact_id uuid DEFAULT NULL,
  p_recipient_employee_id uuid DEFAULT NULL,
  p_recipient_vendor_id uuid DEFAULT NULL,
  p_recipient_phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule_enabled boolean;
  v_phone text := p_recipient_phone;
  v_consent boolean := true;
  v_id uuid;
BEGIN
  SELECT is_enabled INTO v_rule_enabled
  FROM public.sms_event_rules
  WHERE organization_id = p_organization_id
    AND event_type = p_event_type
    AND (business_id IS NOT DISTINCT FROM p_business_id OR business_id IS NULL)
  ORDER BY (business_id = p_business_id) DESC NULLS LAST
  LIMIT 1;

  IF v_rule_enabled IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF v_phone IS NULL THEN
    IF p_recipient_contact_id IS NOT NULL THEN
      SELECT c.phone, COALESCE(c.sms_consent, true)
        INTO v_phone, v_consent
      FROM public.contacts c WHERE c.id = p_recipient_contact_id;
    ELSIF p_recipient_employee_id IS NOT NULL THEN
      SELECT COALESCE(e.personal_phone, e.phone), COALESCE(e.sms_consent, true)
        INTO v_phone, v_consent
      FROM public.employees e WHERE e.id = p_recipient_employee_id;
    ELSIF p_recipient_vendor_id IS NOT NULL THEN
      SELECT c.phone, COALESCE(c.sms_consent, true)
        INTO v_phone, v_consent
      FROM public.contacts c WHERE c.id = p_recipient_vendor_id;
    END IF;
  END IF;

  IF v_consent IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.sms_event_outbox (
    organization_id, business_id, event_type, entity_type, entity_id,
    template_variables, recipient_phone, recipient_contact_id,
    recipient_employee_id, recipient_vendor_id, recipient_type,
    status, attempts, next_attempt_at
  ) VALUES (
    p_organization_id, p_business_id, p_event_type, p_entity_type, p_entity_id,
    COALESCE(p_template_variables, '{}'::jsonb), v_phone, p_recipient_contact_id,
    p_recipient_employee_id, p_recipient_vendor_id, p_recipient_type,
    'queued', 0, now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_sms_event(uuid,uuid,sms_event_type,text,uuid,jsonb,text,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_sms_event(uuid,uuid,sms_event_type,text,uuid,jsonb,text,uuid,uuid,uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_sms_expense_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event sms_event_type;
  v_employee_id uuid;
  v_vars jsonb;
BEGIN
  IF NEW.status::text = OLD.status::text THEN
    RETURN NEW;
  END IF;

  IF NEW.status::text = 'approved' THEN
    v_event := 'expense_approved';
  ELSIF NEW.status::text = 'rejected' THEN
    v_event := 'expense_rejected';
  ELSE
    RETURN NEW;
  END IF;

  SELECT id INTO v_employee_id
  FROM public.employees
  WHERE user_id = NEW.created_by AND organization_id = NEW.organization_id
  LIMIT 1;

  IF v_employee_id IS NULL THEN RETURN NEW; END IF;

  v_vars := jsonb_build_object(
    'amount', NEW.amount::text,
    'currency', COALESCE(NEW.currency, ''),
    'reference', COALESCE(NEW.reference, ''),
    'description', COALESCE(NEW.description, '')
  );

  PERFORM public.enqueue_sms_event(
    NEW.organization_id, NEW.business_id, v_event,
    'expense', NEW.id, v_vars, 'employee',
    NULL, v_employee_id, NULL, NULL
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_sms_expense_state_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_expense_state_change ON public.expenses;
CREATE TRIGGER sms_expense_state_change
AFTER UPDATE OF status ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.tg_sms_expense_state_change();

CREATE OR REPLACE FUNCTION public.tg_sms_payslip_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_vars jsonb;
BEGIN
  IF NEW.status = OLD.status OR NEW.status NOT IN ('paid','processed') THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_business_id FROM public.employees WHERE id = NEW.employee_id;

  v_vars := jsonb_build_object(
    'net_pay', NEW.net_pay::text,
    'period', COALESCE(to_char(NEW.paid_at, 'Mon YYYY'), '')
  );

  PERFORM public.enqueue_sms_event(
    NEW.organization_id, COALESCE(NEW.business_id, v_business_id),
    'payroll_processed', 'payslip', NEW.id, v_vars, 'employee',
    NULL, NEW.employee_id, NULL, NULL
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_sms_payslip_paid failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_payslip_paid ON public.payslips;
CREATE TRIGGER sms_payslip_paid
AFTER UPDATE OF status ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.tg_sms_payslip_paid();

CREATE OR REPLACE FUNCTION public.tg_sms_customer_statement_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vars jsonb;
BEGIN
  IF NEW.sent_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.sent_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_vars := jsonb_build_object(
    'closing_balance', NEW.closing_balance::text,
    'period_end', NEW.period_end::text
  );

  PERFORM public.enqueue_sms_event(
    NEW.organization_id, NEW.business_id, 'customer_statement_sent',
    'customer_statement', NEW.id, v_vars, 'customer',
    NEW.contact_id, NULL, NULL, NULL
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_sms_customer_statement_sent failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_customer_statement_sent ON public.customer_statements;
CREATE TRIGGER sms_customer_statement_sent
AFTER INSERT OR UPDATE OF sent_at ON public.customer_statements
FOR EACH ROW EXECUTE FUNCTION public.tg_sms_customer_statement_sent();

-- Webhook health view (sms_log only has created_at)
CREATE OR REPLACE VIEW public.sms_webhook_health AS
SELECT
  organization_id,
  business_id,
  MAX(CASE WHEN direction = 'inbound' THEN created_at END) AS last_inbound_at,
  MAX(CASE WHEN direction = 'outbound' AND status IN ('delivered','failed','undelivered') THEN created_at END) AS last_status_callback_at,
  COUNT(*) FILTER (WHERE direction = 'inbound' AND created_at > now() - interval '24 hours') AS inbound_24h,
  COUNT(*) FILTER (WHERE direction = 'outbound' AND created_at > now() - interval '24 hours') AS outbound_24h
FROM public.sms_log
GROUP BY organization_id, business_id;

GRANT SELECT ON public.sms_webhook_health TO authenticated;
