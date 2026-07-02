-- 1. Event type enum
DO $$ BEGIN
  CREATE TYPE public.employee_lifecycle_event_type AS ENUM (
    'candidate_created',
    'application_submitted',
    'offer_extended',
    'offer_accepted',
    'offer_declined',
    'hired',
    'onboarding_started',
    'onboarding_completed',
    'probation_started',
    'probation_ended',
    'probation_extended',
    'contract_created',
    'contract_activated',
    'contract_renewed',
    'contract_amended',
    'contract_expired',
    'salary_revised',
    'position_changed',
    'department_transferred',
    'location_transferred',
    'manager_changed',
    'promoted',
    'demoted',
    'suspended',
    'reinstated',
    'leave_of_absence_started',
    'leave_of_absence_ended',
    'termination_initiated',
    'terminated',
    'offboarding_started',
    'offboarding_completed',
    'final_settlement_paid',
    'archived',
    'unarchived',
    'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table
CREATE TABLE public.employee_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  employee_id uuid NOT NULL,
  event_type public.employee_lifecycle_event_type NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  effective_date date,
  actor_user_id uuid,
  actor_label text,
  source_table text,
  source_id uuid,
  summary text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Grants (BEFORE RLS)
GRANT SELECT, INSERT ON public.employee_lifecycle_events TO authenticated;
GRANT ALL ON public.employee_lifecycle_events TO service_role;

-- 4. RLS
ALTER TABLE public.employee_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- Read: org members
CREATE POLICY "lifecycle_events_select_org_members"
ON public.employee_lifecycle_events
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.organization_id = employee_lifecycle_events.organization_id
  )
);

-- Insert: HR managers (manageEmployees permission); falls back to permission_groups via has_permission if present
CREATE POLICY "lifecycle_events_insert_hr_managers"
ON public.employee_lifecycle_events
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.organization_id = employee_lifecycle_events.organization_id
  )
);

-- No update / no delete policies → append-only for non-service_role.

-- 5. Indexes
CREATE INDEX idx_lifecycle_events_employee_occurred
  ON public.employee_lifecycle_events (employee_id, occurred_at DESC);

CREATE INDEX idx_lifecycle_events_org_occurred
  ON public.employee_lifecycle_events (organization_id, occurred_at DESC);

CREATE INDEX idx_lifecycle_events_org_type_occurred
  ON public.employee_lifecycle_events (organization_id, event_type, occurred_at DESC);

CREATE INDEX idx_lifecycle_events_source
  ON public.employee_lifecycle_events (source_table, source_id)
  WHERE source_table IS NOT NULL;

-- 6. Generic projection helper used by triggers + RPCs
CREATE OR REPLACE FUNCTION public.emit_employee_lifecycle_event(
  p_organization_id uuid,
  p_business_id uuid,
  p_employee_id uuid,
  p_event_type public.employee_lifecycle_event_type,
  p_summary text,
  p_payload jsonb,
  p_source_table text,
  p_source_id uuid,
  p_effective_date date DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.employee_lifecycle_events (
    organization_id, business_id, employee_id, event_type,
    effective_date, actor_user_id, summary, payload,
    source_table, source_id
  ) VALUES (
    p_organization_id, p_business_id, p_employee_id, p_event_type,
    p_effective_date, COALESCE(p_actor_user_id, auth.uid()), p_summary, COALESCE(p_payload, '{}'::jsonb),
    p_source_table, p_source_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_employee_lifecycle_event(uuid,uuid,uuid,public.employee_lifecycle_event_type,text,jsonb,text,uuid,date,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.emit_employee_lifecycle_event(uuid,uuid,uuid,public.employee_lifecycle_event_type,text,jsonb,text,uuid,date,uuid) TO authenticated, service_role;

-- 7. Triggers on source tables (idempotent attach)

-- 7a. employees: hire / archive
CREATE OR REPLACE FUNCTION public.tg_employees_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_employee_lifecycle_event(
      NEW.organization_id, NEW.business_id, NEW.id,
      'hired', 'Employee record created',
      jsonb_build_object('hire_date', NEW.hire_date),
      'employees', NEW.id, NEW.hire_date, NULL
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.is_archived, false) IS DISTINCT FROM COALESCE(OLD.is_archived, false) THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        CASE WHEN NEW.is_archived THEN 'archived' ELSE 'unarchived' END,
        CASE WHEN NEW.is_archived THEN 'Employee archived' ELSE 'Employee unarchived' END,
        '{}'::jsonb, 'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'department_transferred', 'Department changed',
        jsonb_build_object('from', OLD.department_id, 'to', NEW.department_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'manager_changed', 'Manager changed',
        jsonb_build_object('from', OLD.manager_id, 'to', NEW.manager_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.position_id IS DISTINCT FROM OLD.position_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'position_changed', 'Position changed',
        jsonb_build_object('from', OLD.position_id, 'to', NEW.position_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.work_location_id IS DISTINCT FROM OLD.work_location_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'location_transferred', 'Work location changed',
        jsonb_build_object('from', OLD.work_location_id, 'to', NEW.work_location_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employees_lifecycle ON public.employees;
CREATE TRIGGER trg_employees_lifecycle
AFTER INSERT OR UPDATE ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.tg_employees_lifecycle();

-- 7b. employee_contracts: created / renewed / expired
CREATE OR REPLACE FUNCTION public.tg_employee_contracts_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_biz uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_employee_lifecycle_event(
      NEW.organization_id, NEW.business_id, NEW.employee_id,
      'contract_created', COALESCE(NEW.contract_reference, 'Contract created'),
      jsonb_build_object('start_date', NEW.start_date, 'end_date', NEW.end_date),
      'employee_contracts', NEW.id, NEW.start_date, NULL
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'active' THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.employee_id,
        'contract_activated', 'Contract activated',
        jsonb_build_object('contract_reference', NEW.contract_reference),
        'employee_contracts', NEW.id, NEW.start_date, NULL
      );
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'expired' THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.employee_id,
        'contract_expired', 'Contract expired',
        jsonb_build_object('contract_reference', NEW.contract_reference),
        'employee_contracts', NEW.id, NEW.end_date, NULL
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_contracts_lifecycle ON public.employee_contracts;
CREATE TRIGGER trg_employee_contracts_lifecycle
AFTER INSERT OR UPDATE ON public.employee_contracts
FOR EACH ROW EXECUTE FUNCTION public.tg_employee_contracts_lifecycle();

-- 7c. employee_onboarding: started / completed
CREATE OR REPLACE FUNCTION public.tg_employee_onboarding_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_employee_lifecycle_event(
      NEW.organization_id, NULL, NEW.employee_id,
      'onboarding_started', 'Onboarding started',
      '{}'::jsonb, 'employee_onboarding', NEW.id, NULL, NULL
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'completed' THEN
    PERFORM public.emit_employee_lifecycle_event(
      NEW.organization_id, NULL, NEW.employee_id,
      'onboarding_completed', 'Onboarding completed',
      '{}'::jsonb, 'employee_onboarding', NEW.id, NULL, NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_onboarding_lifecycle ON public.employee_onboarding;
CREATE TRIGGER trg_employee_onboarding_lifecycle
AFTER INSERT OR UPDATE ON public.employee_onboarding
FOR EACH ROW EXECUTE FUNCTION public.tg_employee_onboarding_lifecycle();

-- 7d. offer_letters: extended / accepted / declined
CREATE OR REPLACE FUNCTION public.tg_offer_letters_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_employee_id uuid;
BEGIN
  -- offer_letters may not have employee_id at extension time; emit against candidate via payload only when employee exists
  IF TG_OP = 'INSERT' THEN
    -- nothing if no employee yet
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- if linked to an employee, log it
    BEGIN
      EXECUTE format('SELECT %I FROM public.offer_letters WHERE id = $1', 'employee_id')
        INTO v_employee_id USING NEW.id;
    EXCEPTION WHEN undefined_column THEN
      v_employee_id := NULL;
    END;
    IF v_employee_id IS NOT NULL THEN
      IF NEW.status = 'accepted' THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NULL, v_employee_id,
          'offer_accepted', 'Offer accepted', '{}'::jsonb, 'offer_letters', NEW.id, NULL, NULL
        );
      ELSIF NEW.status = 'declined' THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NULL, v_employee_id,
          'offer_declined', 'Offer declined', '{}'::jsonb, 'offer_letters', NEW.id, NULL, NULL
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_offer_letters_lifecycle ON public.offer_letters;
CREATE TRIGGER trg_offer_letters_lifecycle
AFTER INSERT OR UPDATE ON public.offer_letters
FOR EACH ROW EXECUTE FUNCTION public.tg_offer_letters_lifecycle();

-- 8. Backfill from existing data (best-effort; ignores rows with missing org_id)
INSERT INTO public.employee_lifecycle_events (
  organization_id, business_id, employee_id, event_type, occurred_at, effective_date, summary, payload, source_table, source_id
)
SELECT e.organization_id, e.business_id, e.id, 'hired',
       COALESCE(e.created_at, now()), e.hire_date,
       'Employee record created (backfill)',
       jsonb_build_object('hire_date', e.hire_date),
       'employees', e.id
FROM public.employees e
WHERE e.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.employee_lifecycle_events (
  organization_id, business_id, employee_id, event_type, occurred_at, effective_date, summary, payload, source_table, source_id
)
SELECT c.organization_id, c.business_id, c.employee_id, 'contract_created',
       COALESCE(c.created_at, now()), c.start_date,
       COALESCE(c.contract_reference, 'Contract (backfill)'),
       jsonb_build_object('start_date', c.start_date, 'end_date', c.end_date, 'status', c.status),
       'employee_contracts', c.id
FROM public.employee_contracts c
WHERE c.organization_id IS NOT NULL AND c.employee_id IS NOT NULL
ON CONFLICT DO NOTHING;