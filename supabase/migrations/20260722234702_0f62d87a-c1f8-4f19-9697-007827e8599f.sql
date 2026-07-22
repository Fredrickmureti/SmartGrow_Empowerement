
-- ═══════════════════════════════════════════════════════════════════════
-- Phase 6b: Legal Order outbox consumers
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Remittance-line projection --------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_order_remittance_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id       uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  garnishment_id    uuid NOT NULL REFERENCES public.employee_garnishments(id) ON DELETE CASCADE,
  payment_id        uuid NOT NULL,               -- payroll_remittance_payments.id
  journal_entry_id  uuid,
  source_event_id   uuid NOT NULL UNIQUE,        -- business_event_outbox.id — idempotency
  amount            numeric(14,2) NOT NULL,
  reference_number  text,
  payment_date      date NOT NULL,
  actor_user_id     uuid REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS legal_order_remittance_lines_org_idx
  ON public.legal_order_remittance_lines (organization_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS legal_order_remittance_lines_order_idx
  ON public.legal_order_remittance_lines (garnishment_id, payment_date DESC);

GRANT SELECT ON public.legal_order_remittance_lines TO authenticated;
GRANT ALL ON public.legal_order_remittance_lines TO service_role;

ALTER TABLE public.legal_order_remittance_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_order_remittance_lines_read
  ON public.legal_order_remittance_lines FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

-- Writes are dispatcher-only (service_role); no INSERT policy on purpose.

COMMENT ON TABLE public.legal_order_remittance_lines IS
  'Idempotent projection of legal_order.payment_posted outbox events into a finance-visible remittance ledger.';

-- 2. Dispatch log (notification idempotency) --------------------------------
CREATE TABLE IF NOT EXISTS public.legal_order_event_dispatch_log (
  source_event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  topic           text NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  notified_users  integer NOT NULL DEFAULT 0
);

GRANT SELECT ON public.legal_order_event_dispatch_log TO authenticated;
GRANT ALL ON public.legal_order_event_dispatch_log TO service_role;

ALTER TABLE public.legal_order_event_dispatch_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_order_event_dispatch_log_read
  ON public.legal_order_event_dispatch_log FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- 3. RPC: append remittance line (idempotent) -------------------------------
CREATE OR REPLACE FUNCTION public.legal_order_apply_payment_remittance(
  p_event_id  uuid,
  p_org_id    uuid,
  p_business  uuid,
  p_payload   jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.legal_order_remittance_lines (
    organization_id, business_id, garnishment_id, payment_id,
    journal_entry_id, source_event_id, amount, reference_number,
    payment_date, actor_user_id
  )
  VALUES (
    p_org_id,
    p_business,
    (p_payload->>'legal_order_id')::uuid,
    (p_payload->>'payment_id')::uuid,
    NULLIF(p_payload->>'journal_entry_id','')::uuid,
    p_event_id,
    COALESCE((p_payload->>'amount')::numeric, 0),
    p_payload->>'reference_number',
    COALESCE((p_payload->>'payment_date')::date, CURRENT_DATE),
    NULLIF(p_payload->>'actor_user_id','')::uuid
  )
  ON CONFLICT (source_event_id) DO NOTHING
  RETURNING id INTO v_id;

  -- If duplicate, return existing id
  IF v_id IS NULL THEN
    SELECT id INTO v_id
      FROM public.legal_order_remittance_lines
     WHERE source_event_id = p_event_id;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_apply_payment_remittance(uuid, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_apply_payment_remittance(uuid, uuid, uuid, jsonb) TO service_role;

-- 4. RPC: fan out in-app notifications (idempotent) -------------------------
CREATE OR REPLACE FUNCTION public.legal_order_notify_event(
  p_event_id uuid,
  p_org_id   uuid,
  p_business uuid,
  p_topic    text,
  p_payload  jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_already boolean;
  v_count   integer := 0;
  v_title   text;
  v_message text;
  v_link    text;
  v_entity  uuid;
  r         record;
BEGIN
  -- Idempotency: skip if this event has already been dispatched.
  SELECT true INTO v_already
    FROM public.legal_order_event_dispatch_log
   WHERE source_event_id = p_event_id;
  IF v_already THEN
    RETURN 0;
  END IF;

  v_entity := NULLIF(p_payload->>'legal_order_id','')::uuid;
  IF v_entity IS NULL THEN
    v_entity := NULLIF(p_payload->>'garnishment_id','')::uuid;
  END IF;

  -- Human-friendly title/message per topic (fallback = topic itself).
  v_title := CASE p_topic
    WHEN 'legal_order.submit'                THEN 'Legal order submitted for approval'
    WHEN 'legal_order.approve'               THEN 'Legal order approved'
    WHEN 'legal_order.reject'                THEN 'Legal order rejected'
    WHEN 'legal_order.activate'              THEN 'Legal order activated'
    WHEN 'legal_order.suspend'               THEN 'Legal order suspended'
    WHEN 'legal_order.resume'                THEN 'Legal order resumed'
    WHEN 'legal_order.mark_satisfied'        THEN 'Legal order satisfied'
    WHEN 'legal_order.release'               THEN 'Legal order released'
    WHEN 'legal_order.expire'                THEN 'Legal order expired'
    WHEN 'legal_order.terminate_unsatisfied' THEN 'Legal order terminated (balance owed)'
    WHEN 'legal_order.payment_posted'        THEN 'Garnishment payment posted'
    ELSE p_topic
  END;

  v_message := COALESCE(p_payload->>'reason_text', v_title);
  v_link    := '/hr/payroll/legal-orders';

  -- Fan out to admins / owners / accountants / super_admins / managers
  -- who are active members of this org.
  FOR r IN
    SELECT DISTINCT ur.user_id
      FROM public.user_roles ur
     WHERE ur.organization_id = p_org_id
       AND COALESCE(ur.is_active, true) = true
       AND ur.role IN ('admin','owner','accountant','super_admin','manager')
  LOOP
    PERFORM public.create_notification(
      p_org_id,
      r.user_id,
      'info',
      'payroll',
      v_title,
      v_message,
      v_link,
      'legal_order',
      v_entity,
      CASE
        WHEN p_topic IN ('legal_order.activate','legal_order.approve','legal_order.terminate_unsatisfied') THEN 2
        WHEN p_topic IN ('legal_order.suspend','legal_order.expire','legal_order.reject') THEN 1
        ELSE 0
      END,
      p_business
    );
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.legal_order_event_dispatch_log
    (source_event_id, organization_id, topic, notified_users)
  VALUES (p_event_id, p_org_id, p_topic, v_count)
  ON CONFLICT (source_event_id) DO NOTHING;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_notify_event(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_notify_event(uuid, uuid, uuid, text, jsonb) TO service_role;
