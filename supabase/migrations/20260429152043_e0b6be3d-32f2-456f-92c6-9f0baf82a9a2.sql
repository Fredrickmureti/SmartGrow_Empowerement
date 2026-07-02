
-- ============================================================================
-- SMS production-grade hardening — Batch 1: schema
-- ============================================================================

-- ---- sms_provider_configs: STOP/HELP support ----
ALTER TABLE public.sms_provider_configs
  ADD COLUMN IF NOT EXISTS help_message text NOT NULL DEFAULT 'Reply STOP to unsubscribe. For help, contact support.',
  ADD COLUMN IF NOT EXISTS inbound_enabled boolean NOT NULL DEFAULT true;

-- ---- sms_log: inbound + cost + retry ----
ALTER TABLE public.sms_log
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound','inbound')),
  ADD COLUMN IF NOT EXISTS cost_unit text,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sms_log_retry
  ON public.sms_log (next_retry_at)
  WHERE status = 'queued' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_org_created
  ON public.sms_log (organization_id, created_at DESC);

-- ---- sms_templates: one active per (org, event_type) ----
CREATE UNIQUE INDEX IF NOT EXISTS ux_sms_templates_one_active_per_event
  ON public.sms_templates (organization_id, event_type)
  WHERE is_active;

-- ---- sms_event_outbox: queue table for automatic events ----
CREATE TABLE IF NOT EXISTS public.sms_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid,
  event_type public.sms_event_type NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  recipient_phone text,
  recipient_contact_id uuid,
  template_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sms_event_outbox_pending
  ON public.sms_event_outbox (next_attempt_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_sms_event_outbox_org
  ON public.sms_event_outbox (organization_id, created_at DESC);

ALTER TABLE public.sms_event_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view their sms outbox" ON public.sms_event_outbox;
CREATE POLICY "Org members can view their sms outbox"
ON public.sms_event_outbox
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = sms_event_outbox.organization_id
      AND ur.is_active = true
  )
);
-- INSERT/UPDATE/DELETE intentionally unset → only service_role bypasses RLS.

-- ---- helper: is event rule enabled? ----
CREATE OR REPLACE FUNCTION public.sms_event_rule_enabled(
  p_org_id uuid,
  p_event public.sms_event_type
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT is_enabled FROM public.sms_event_rules
     WHERE organization_id = p_org_id AND event_type = p_event
     LIMIT 1),
    false
  );
$$;

-- ---- helper: enqueue outbox row (used by triggers) ----
CREATE OR REPLACE FUNCTION public.sms_enqueue_event(
  p_org_id uuid,
  p_business_id uuid,
  p_event public.sms_event_type,
  p_entity_type text,
  p_entity_id uuid,
  p_contact_id uuid,
  p_vars jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enqueue if the rule is enabled for this org
  IF NOT public.sms_event_rule_enabled(p_org_id, p_event) THEN
    RETURN;
  END IF;

  INSERT INTO public.sms_event_outbox(
    organization_id, business_id, event_type, entity_type, entity_id,
    recipient_contact_id, template_variables
  ) VALUES (
    p_org_id, p_business_id, p_event, p_entity_type, p_entity_id,
    p_contact_id, COALESCE(p_vars, '{}'::jsonb)
  );
END;
$$;

-- ---- triggers on transactional tables ----

-- Invoices: invoice_posted on status -> 'posted' (or 'sent'/'open'/'authorised')
CREATE OR REPLACE FUNCTION public.trg_sms_invoice_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('posted','sent','open','authorised'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('posted','sent','open','authorised')
         AND COALESCE(OLD.status::text,'') NOT IN ('posted','sent','open','authorised')) THEN
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'invoice_posted'::public.sms_event_type,
      'invoice', NEW.id, NEW.contact_id,
      jsonb_build_object(
        'invoice_number', COALESCE(NEW.invoice_number, ''),
        'amount', COALESCE(NEW.total::text, '')
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_invoice_posted_trg ON public.invoices;
CREATE TRIGGER sms_invoice_posted_trg
AFTER INSERT OR UPDATE OF status ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_invoice_posted();

-- Sales orders: sales_order_confirmed
CREATE OR REPLACE FUNCTION public.trg_sms_sales_order_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('confirmed','approved','sent'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('confirmed','approved','sent')
         AND COALESCE(OLD.status::text,'') NOT IN ('confirmed','approved','sent')) THEN
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'sales_order_confirmed'::public.sms_event_type,
      'sales_order', NEW.id, NEW.contact_id,
      jsonb_build_object('amount', COALESCE(NEW.total::text, ''))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_sales_order_confirmed_trg ON public.sales_orders;
CREATE TRIGGER sms_sales_order_confirmed_trg
AFTER INSERT OR UPDATE OF status ON public.sales_orders
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_sales_order_confirmed();

-- Delivery notes: delivery_shipped
CREATE OR REPLACE FUNCTION public.trg_sms_delivery_shipped()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status IN ('shipped','sent','delivered'))
     OR (TG_OP = 'UPDATE' AND NEW.status IN ('shipped','sent','delivered')
         AND COALESCE(OLD.status,'') NOT IN ('shipped','sent','delivered')) THEN
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'delivery_shipped'::public.sms_event_type,
      'delivery_note', NEW.id, NEW.contact_id, '{}'::jsonb
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_delivery_shipped_trg ON public.delivery_notes;
CREATE TRIGGER sms_delivery_shipped_trg
AFTER INSERT OR UPDATE OF status ON public.delivery_notes
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_delivery_shipped();

-- Credit notes: credit_note_issued
CREATE OR REPLACE FUNCTION public.trg_sms_credit_note_issued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status::text IN ('issued','posted','sent','applied'))
     OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('issued','posted','sent','applied')
         AND COALESCE(OLD.status::text,'') NOT IN ('issued','posted','sent','applied')) THEN
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'credit_note_issued'::public.sms_event_type,
      'credit_note', NEW.id, NEW.contact_id,
      jsonb_build_object('amount', COALESCE(NEW.total::text, ''))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_credit_note_issued_trg ON public.credit_notes;
CREATE TRIGGER sms_credit_note_issued_trg
AFTER INSERT OR UPDATE OF status ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_credit_note_issued();

-- Estimates: estimate_sent
CREATE OR REPLACE FUNCTION public.trg_sms_estimate_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND NEW.status::text IN ('sent','accepted')
      AND COALESCE(OLD.status::text,'') NOT IN ('sent','accepted')) THEN
    PERFORM public.sms_enqueue_event(
      NEW.organization_id, NEW.business_id, 'estimate_sent'::public.sms_event_type,
      'estimate', NEW.id, NEW.contact_id,
      jsonb_build_object('amount', COALESCE(NEW.total::text, ''))
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_estimate_sent_trg ON public.estimates;
CREATE TRIGGER sms_estimate_sent_trg
AFTER UPDATE OF status ON public.estimates
FOR EACH ROW EXECUTE FUNCTION public.trg_sms_estimate_sent();
