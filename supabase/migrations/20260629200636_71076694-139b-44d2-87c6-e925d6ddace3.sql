-- Phase 4 P2 — Payslip lifecycle journal.
-- Country-agnostic. Append-only. Generic event vocabulary.

DO $$ BEGIN
  CREATE TYPE public.payslip_event_type AS ENUM (
    'generated',
    'recomputed',
    'approved',
    'posted',
    'paid',
    'cancelled',
    'corrected',
    'superseded',
    'reissued',
    'viewed',
    'downloaded',
    'emailed',
    'signed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.payslip_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payslip_id uuid NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
  event_type public.payslip_event_type NOT NULL,
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  organization_id uuid NOT NULL,
  business_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.payslip_events TO authenticated;
GRANT ALL ON public.payslip_events TO service_role;

ALTER TABLE public.payslip_events ENABLE ROW LEVEL SECURITY;

-- Read: HR with payroll read on the org, OR the employee who owns the payslip.
DROP POLICY IF EXISTS payslip_events_select ON public.payslip_events;
CREATE POLICY payslip_events_select ON public.payslip_events
  FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll'::text, 'read'::text)
    OR public.payslip_visible_to_employee(payslip_id)
  );

-- Hard-deny client UPDATE / DELETE — append-only by policy.
-- (No INSERT policy is created: clients cannot insert directly. All inserts
--  go through public.emit_payslip_event() which is SECURITY DEFINER and
--  bypasses RLS.)
DROP POLICY IF EXISTS payslip_events_no_update ON public.payslip_events;
CREATE POLICY payslip_events_no_update ON public.payslip_events
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS payslip_events_no_delete ON public.payslip_events;
CREATE POLICY payslip_events_no_delete ON public.payslip_events
  FOR DELETE TO authenticated USING (false);

-- Append-only enforcement at the row level: no UPDATE or DELETE allowed
-- even by service_role unless the caller explicitly disables the trigger.
CREATE OR REPLACE FUNCTION public.payslip_events_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payslip_events is append-only (% is forbidden)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_payslip_events_no_update ON public.payslip_events;
CREATE TRIGGER trg_payslip_events_no_update
  BEFORE UPDATE ON public.payslip_events
  FOR EACH ROW EXECUTE FUNCTION public.payslip_events_forbid_mutation();

DROP TRIGGER IF EXISTS trg_payslip_events_no_delete ON public.payslip_events;
CREATE TRIGGER trg_payslip_events_no_delete
  BEFORE DELETE ON public.payslip_events
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION public.payslip_events_forbid_mutation();
-- Note: ON DELETE CASCADE from payslips runs at trigger depth > 0 and is allowed.

CREATE INDEX IF NOT EXISTS idx_payslip_events_payslip
  ON public.payslip_events (payslip_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_payslip_events_org_occurred
  ON public.payslip_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_payslip_events_type
  ON public.payslip_events (event_type, occurred_at DESC);

COMMENT ON TABLE public.payslip_events IS
  'Append-only lifecycle journal for payslips (Phase 4 P2). Every meaningful event — generated/recomputed/approved/posted/paid/cancelled/corrected/superseded/reissued/viewed/downloaded/emailed/signed — produces one immutable row. Country-agnostic; no statutory vocabulary here.';

-- ── Emit helper ──────────────────────────────────────────────────────────
-- SECURITY DEFINER so application paths (PDF generator, mailer, portal) can
-- record events without needing direct INSERT on the audit table.
CREATE OR REPLACE FUNCTION public.emit_payslip_event(
  p_payslip_id uuid,
  p_event_type public.payslip_event_type,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_user_id uuid DEFAULT NULL,
  p_ip inet DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_id uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz
  FROM public.payslips WHERE id = p_payslip_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'payslip % not found', p_payslip_id;
  END IF;

  INSERT INTO public.payslip_events (
    payslip_id, event_type, actor_user_id, metadata, ip, user_agent,
    organization_id, business_id, occurred_at
  ) VALUES (
    p_payslip_id,
    p_event_type,
    COALESCE(p_actor_user_id, auth.uid()),
    COALESCE(p_metadata, '{}'::jsonb),
    p_ip,
    p_user_agent,
    v_org,
    v_biz,
    COALESCE(p_occurred_at, now())
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_payslip_event(uuid, public.payslip_event_type, jsonb, uuid, inet, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_payslip_event(uuid, public.payslip_event_type, jsonb, uuid, inet, text, timestamptz) TO authenticated, service_role;

-- ── Status-transition trigger on payslips ───────────────────────────────
-- Maps text status transitions to enum events. Country-agnostic; statuses
-- come from the existing payslips.status text column.
CREATE OR REPLACE FUNCTION public.payslips_emit_lifecycle_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.payslip_event_type;
  v_meta jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.payslip_events (
      payslip_id, event_type, actor_user_id, metadata,
      organization_id, business_id
    ) VALUES (
      NEW.id,
      'generated',
      auth.uid(),
      jsonb_build_object(
        'status', NEW.status,
        'payroll_run_id', NEW.payroll_run_id,
        'rule_set_version', NEW.rule_set_version,
        'pack_version_id', NEW.pack_version_id
      ),
      NEW.organization_id,
      NEW.business_id
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_meta := jsonb_build_object('from_status', OLD.status, 'to_status', NEW.status);
    v_event := CASE NEW.status
      WHEN 'approved'   THEN 'approved'::public.payslip_event_type
      WHEN 'posted'     THEN 'posted'::public.payslip_event_type
      WHEN 'paid'       THEN 'paid'::public.payslip_event_type
      WHEN 'cancelled'  THEN 'cancelled'::public.payslip_event_type
      WHEN 'superseded' THEN 'superseded'::public.payslip_event_type
      WHEN 'corrected'  THEN 'corrected'::public.payslip_event_type
      WHEN 'reissued'   THEN 'reissued'::public.payslip_event_type
      WHEN 'pending'    THEN 'recomputed'::public.payslip_event_type
      ELSE NULL
    END;
    IF v_event IS NOT NULL THEN
      INSERT INTO public.payslip_events (
        payslip_id, event_type, actor_user_id, metadata,
        organization_id, business_id
      ) VALUES (
        NEW.id, v_event, auth.uid(), v_meta,
        NEW.organization_id, NEW.business_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payslips_emit_lifecycle ON public.payslips;
CREATE TRIGGER trg_payslips_emit_lifecycle
  AFTER INSERT OR UPDATE OF status ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.payslips_emit_lifecycle_events();