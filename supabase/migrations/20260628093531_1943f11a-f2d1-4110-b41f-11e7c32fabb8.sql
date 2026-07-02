
-- Enum for amendment kinds
DO $$ BEGIN
  CREATE TYPE public.contract_amendment_kind AS ENUM (
    'renewal','salary_revision','position_change','location_change',
    'schedule_change','allowance_change','end_date_change','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Table
CREATE TABLE public.contract_amendments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  contract_id UUID NOT NULL REFERENCES public.employee_contracts(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind public.contract_amendment_kind NOT NULL,
  effective_on DATE NOT NULL,
  actor_user_id UUID,
  summary TEXT,
  before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  successor_contract_id UUID REFERENCES public.employee_contracts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contract_amendments_contract ON public.contract_amendments(contract_id, effective_on DESC);
CREATE INDEX idx_contract_amendments_employee ON public.contract_amendments(employee_id, effective_on DESC);
CREATE INDEX idx_contract_amendments_org ON public.contract_amendments(organization_id, created_at DESC);

-- Grants
GRANT SELECT ON public.contract_amendments TO authenticated;
GRANT ALL ON public.contract_amendments TO service_role;

-- RLS (read-only via policies; writes only through SECURITY DEFINER RPCs)
ALTER TABLE public.contract_amendments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contract_amendments_read_authenticated"
  ON public.contract_amendments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "contract_amendments_service_role_all"
  ON public.contract_amendments FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- RPC: renew_contract — clones the contract row with new dates/wage, expires the old, records amendment + lifecycle event
CREATE OR REPLACE FUNCTION public.renew_contract(
  p_contract_id UUID,
  p_new_start DATE,
  p_new_end DATE DEFAULT NULL,
  p_new_wage NUMERIC DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.employee_contracts;
  v_new_id UUID;
  v_actor UUID := auth.uid();
  v_before JSONB;
  v_after JSONB;
BEGIN
  SELECT * INTO v_old FROM public.employee_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract % not found', p_contract_id; END IF;

  v_before := to_jsonb(v_old);

  INSERT INTO public.employee_contracts (
    organization_id, business_id, employee_id, contract_reference, name,
    start_date, end_date, status, wage, housing_allowance, transport_allowance,
    other_allowances, working_schedule, notes, created_by
  ) VALUES (
    v_old.organization_id, v_old.business_id, v_old.employee_id,
    v_old.contract_reference || '-R' || to_char(now(),'YYYYMMDDHH24MISS'),
    v_old.name, p_new_start, p_new_end, 'running',
    COALESCE(p_new_wage, v_old.wage),
    v_old.housing_allowance, v_old.transport_allowance, v_old.other_allowances,
    v_old.working_schedule, v_old.notes, v_actor
  ) RETURNING id INTO v_new_id;

  UPDATE public.employee_contracts SET status='expired', updated_at=now() WHERE id = p_contract_id;

  SELECT to_jsonb(ec.*) INTO v_after FROM public.employee_contracts ec WHERE id = v_new_id;

  INSERT INTO public.contract_amendments(
    organization_id, business_id, contract_id, employee_id, kind, effective_on,
    actor_user_id, summary, before_snapshot, after_snapshot, successor_contract_id
  ) VALUES (
    v_old.organization_id, v_old.business_id, p_contract_id, v_old.employee_id,
    'renewal', p_new_start, v_actor,
    'Contract renewed', v_before, v_after, v_new_id
  );

  INSERT INTO public.employee_lifecycle_events(
    organization_id, business_id, employee_id, event_type, occurred_at,
    actor_user_id, source_table, source_id, payload
  ) VALUES (
    v_old.organization_id, v_old.business_id, v_old.employee_id,
    'contract_renewed', now(), v_actor, 'employee_contracts', v_new_id,
    jsonb_build_object('previous_contract_id', p_contract_id, 'new_contract_id', v_new_id)
  );

  RETURN v_new_id;
END $$;

-- RPC: amend_contract — applies a JSONB patch in-place
CREATE OR REPLACE FUNCTION public.amend_contract(
  p_contract_id UUID,
  p_kind public.contract_amendment_kind,
  p_effective_on DATE,
  p_changes JSONB,
  p_summary TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.employee_contracts;
  v_actor UUID := auth.uid();
  v_amendment_id UUID;
  v_before JSONB;
  v_after JSONB;
  v_allowed TEXT[] := ARRAY['wage','housing_allowance','transport_allowance','other_allowances','working_schedule','end_date','notes'];
  v_key TEXT;
BEGIN
  SELECT * INTO v_old FROM public.employee_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract % not found', p_contract_id; END IF;

  v_before := to_jsonb(v_old);

  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF NOT (v_key = ANY(v_allowed)) THEN
      RAISE EXCEPTION 'Field % cannot be amended', v_key;
    END IF;
  END LOOP;

  UPDATE public.employee_contracts SET
    wage = COALESCE((p_changes->>'wage')::numeric, wage),
    housing_allowance = COALESCE((p_changes->>'housing_allowance')::numeric, housing_allowance),
    transport_allowance = COALESCE((p_changes->>'transport_allowance')::numeric, transport_allowance),
    other_allowances = COALESCE(p_changes->'other_allowances', other_allowances),
    working_schedule = COALESCE(p_changes->>'working_schedule', working_schedule),
    end_date = CASE WHEN p_changes ? 'end_date' THEN NULLIF(p_changes->>'end_date','')::date ELSE end_date END,
    notes = COALESCE(p_changes->>'notes', notes),
    updated_at = now()
  WHERE id = p_contract_id;

  SELECT to_jsonb(ec.*) INTO v_after FROM public.employee_contracts ec WHERE id = p_contract_id;

  INSERT INTO public.contract_amendments(
    organization_id, business_id, contract_id, employee_id, kind, effective_on,
    actor_user_id, summary, before_snapshot, after_snapshot
  ) VALUES (
    v_old.organization_id, v_old.business_id, p_contract_id, v_old.employee_id,
    p_kind, p_effective_on, v_actor, p_summary, v_before, v_after
  ) RETURNING id INTO v_amendment_id;

  INSERT INTO public.employee_lifecycle_events(
    organization_id, business_id, employee_id, event_type, occurred_at,
    actor_user_id, source_table, source_id, payload
  ) VALUES (
    v_old.organization_id, v_old.business_id, v_old.employee_id,
    'contract_amended', now(), v_actor, 'contract_amendments', v_amendment_id,
    jsonb_build_object('contract_id', p_contract_id, 'kind', p_kind, 'changes', p_changes)
  );

  RETURN v_amendment_id;
END $$;

GRANT EXECUTE ON FUNCTION public.renew_contract(UUID, DATE, DATE, NUMERIC) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.amend_contract(UUID, public.contract_amendment_kind, DATE, JSONB, TEXT) TO authenticated, service_role;
