
CREATE TABLE IF NOT EXISTS public.garnishment_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  garnishment_id uuid NOT NULL REFERENCES public.employee_garnishments(id) ON DELETE CASCADE,
  event text NOT NULL,
  from_status public.garnishment_status,
  to_status   public.garnishment_status NOT NULL,
  reason_code text,
  reason_text text,
  evidence_document_url text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS garnishment_lifecycle_events_garnish_idx
  ON public.garnishment_lifecycle_events(garnishment_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS garnishment_lifecycle_events_org_idx
  ON public.garnishment_lifecycle_events(organization_id, effective_at DESC);

GRANT SELECT ON public.garnishment_lifecycle_events TO authenticated;
GRANT ALL    ON public.garnishment_lifecycle_events TO service_role;

ALTER TABLE public.garnishment_lifecycle_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY garnishment_lifecycle_events_read
  ON public.garnishment_lifecycle_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.employee_garnishments g
       WHERE g.id = garnishment_lifecycle_events.garnishment_id
         AND (
           public.has_role(auth.uid(), 'admin')
           OR public.has_role(auth.uid(), 'manager')
           OR EXISTS (
             SELECT 1 FROM public.employees e
              WHERE e.id = g.employee_id AND e.user_id = auth.uid()
           )
         )
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='draft' AND enumtypid='public.garnishment_status'::regtype) THEN
    ALTER TYPE public.garnishment_status ADD VALUE 'draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='pending_approval' AND enumtypid='public.garnishment_status'::regtype) THEN
    ALTER TYPE public.garnishment_status ADD VALUE 'pending_approval';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='approved' AND enumtypid='public.garnishment_status'::regtype) THEN
    ALTER TYPE public.garnishment_status ADD VALUE 'approved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='terminated_unsatisfied' AND enumtypid='public.garnishment_status'::regtype) THEN
    ALTER TYPE public.garnishment_status ADD VALUE 'terminated_unsatisfied';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.garnishment_transition(
  p_garnishment_id uuid,
  p_action text,
  p_reason_code text DEFAULT NULL,
  p_reason_text text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.employee_garnishments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.employee_garnishments;
  v_from public.garnishment_status;
  v_to   public.garnishment_status;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO v_row FROM public.employee_garnishments WHERE id = p_garnishment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (public.has_role(v_actor, 'admin') OR public.has_role(v_actor, 'manager')) THEN
    RAISE EXCEPTION 'GARNISHMENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_from := v_row.status;

  v_to := CASE
    WHEN p_action = 'submit'                 AND v_from = 'draft'            THEN 'pending_approval'::public.garnishment_status
    WHEN p_action = 'approve'                AND v_from = 'pending_approval' THEN 'approved'::public.garnishment_status
    WHEN p_action = 'reject'                 AND v_from = 'pending_approval' THEN 'draft'::public.garnishment_status
    WHEN p_action = 'activate'               AND v_from IN ('draft','approved') THEN 'active'::public.garnishment_status
    WHEN p_action = 'suspend'                AND v_from = 'active'           THEN 'suspended'::public.garnishment_status
    WHEN p_action = 'resume'                 AND v_from = 'suspended'        THEN 'active'::public.garnishment_status
    WHEN p_action = 'mark_satisfied'         AND v_from IN ('active','suspended') THEN 'satisfied'::public.garnishment_status
    WHEN p_action = 'release'                AND v_from IN ('active','suspended') THEN 'released'::public.garnishment_status
    WHEN p_action = 'expire'                 AND v_from IN ('active','suspended') THEN 'expired'::public.garnishment_status
    WHEN p_action = 'terminate_unsatisfied'  AND v_from IN ('active','suspended') THEN 'terminated_unsatisfied'::public.garnishment_status
    WHEN p_action IN ('adjust_balance','attach_evidence','note') THEN v_from
    ELSE NULL
  END;

  IF v_to IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_INVALID_TRANSITION: % from %', p_action, v_from
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'release' AND COALESCE(p_evidence_url, v_row.document_url) IS NULL THEN
    RAISE EXCEPTION 'GARNISHMENT_RELEASE_REQUIRES_EVIDENCE' USING ERRCODE = '22023';
  END IF;

  UPDATE public.employee_garnishments
     SET status = v_to,
         is_active = (v_to = 'active'),
         status_changed_at = now(),
         status_changed_by = v_actor,
         status_reason = COALESCE(p_reason_text, status_reason),
         document_url = COALESCE(p_evidence_url, document_url)
   WHERE id = p_garnishment_id
   RETURNING * INTO v_row;

  INSERT INTO public.garnishment_lifecycle_events
    (organization_id, business_id, garnishment_id, event, from_status, to_status,
     reason_code, reason_text, evidence_document_url, actor_user_id, payload)
  VALUES
    (v_row.organization_id, v_row.business_id, v_row.id, p_action, v_from, v_to,
     p_reason_code, p_reason_text, p_evidence_url, v_actor, COALESCE(p_payload, '{}'::jsonb));

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.garnishment_transition(uuid,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.garnishment_transition(uuid,text,text,text,text,jsonb) TO authenticated;

COMMENT ON FUNCTION public.garnishment_transition IS
  'P1 FSM gate for employee_garnishments status changes. UI must call this RPC; service_role can still write directly for engine/backfill. Writes a row in garnishment_lifecycle_events.';

CREATE OR REPLACE FUNCTION public.garnishment_auto_expire()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer := 0;
  r public.employee_garnishments;
BEGIN
  FOR r IN
    SELECT * FROM public.employee_garnishments
     WHERE end_date IS NOT NULL
       AND end_date < current_date
       AND status IN ('active','suspended')
  LOOP
    UPDATE public.employee_garnishments
       SET status='expired', is_active=false,
           status_changed_at=now(), status_reason='end_date reached'
     WHERE id = r.id;
    INSERT INTO public.garnishment_lifecycle_events
      (organization_id, business_id, garnishment_id, event, from_status, to_status, reason_code, reason_text)
    VALUES
      (r.organization_id, r.business_id, r.id, 'expire', r.status, 'expired',
       'end_date_reached', 'Auto-expired by garnishment_auto_expire()');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION public.garnishment_auto_expire() TO service_role;

INSERT INTO public.garnishment_lifecycle_events
  (organization_id, business_id, garnishment_id, event, from_status, to_status, reason_code, reason_text, effective_at)
SELECT g.organization_id, g.business_id, g.id, 'activate', NULL, g.status,
       'p1_backfill', 'Backfilled by P1 migration', g.created_at
  FROM public.employee_garnishments g
 WHERE NOT EXISTS (
   SELECT 1 FROM public.garnishment_lifecycle_events e WHERE e.garnishment_id = g.id
 );

COMMENT ON COLUMN public.approval_workflows.entity_type IS
  'Free-text discriminator. Garnishment subsystem uses ''garnishment_order''.';
