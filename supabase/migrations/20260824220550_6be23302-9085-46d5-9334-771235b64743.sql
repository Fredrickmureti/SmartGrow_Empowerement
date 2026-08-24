-- =====================================================================
-- CRM Phase 2 — Lifecycle state machine
-- =====================================================================

-- 1. Authoritative status ------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.crm_lead_status AS ENUM ('new','qualified','proposition','won','lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS status public.crm_lead_status NOT NULL DEFAULT 'new';

UPDATE public.crm_leads l
   SET status = CASE
     WHEN l.won_at  IS NOT NULL THEN 'won'::public.crm_lead_status
     WHEN l.lost_at IS NOT NULL THEN 'lost'::public.crm_lead_status
     WHEN l.type = 'opportunity' THEN 'qualified'::public.crm_lead_status
     ELSE 'new'::public.crm_lead_status
   END
 WHERE l.status = 'new';

-- Normalise pre-existing rows so the invariants below can be enforced.
UPDATE public.crm_leads SET probability = 100 WHERE status = 'won'  AND coalesce(probability,0) <> 100;
UPDATE public.crm_leads SET probability = 0   WHERE status = 'lost' AND coalesce(probability,0) <> 0;
UPDATE public.crm_leads SET won_at = NULL     WHERE status <> 'won'  AND won_at IS NOT NULL;
UPDATE public.crm_leads SET lost_at = NULL    WHERE status <> 'lost' AND lost_at IS NOT NULL;

ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_terminal_consistency,
  DROP CONSTRAINT IF EXISTS crm_leads_probability_range;

ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_terminal_consistency CHECK (
    (status = 'won'  AND won_at  IS NOT NULL AND lost_at IS NULL AND coalesce(probability,0) = 100) OR
    (status = 'lost' AND lost_at IS NOT NULL AND won_at  IS NULL AND coalesce(probability,0) = 0)   OR
    (status NOT IN ('won','lost') AND won_at IS NULL AND lost_at IS NULL)
  ),
  ADD CONSTRAINT crm_leads_probability_range CHECK (probability IS NULL OR probability BETWEEN 0 AND 100);

-- 2. Terminal stage integrity per business -------------------------------
UPDATE public.crm_stages SET is_lost = false WHERE is_won AND is_lost;

ALTER TABLE public.crm_stages
  DROP CONSTRAINT IF EXISTS crm_stages_not_both_terminal;
ALTER TABLE public.crm_stages
  ADD CONSTRAINT crm_stages_not_both_terminal CHECK (NOT (is_won AND is_lost));

CREATE UNIQUE INDEX IF NOT EXISTS crm_stages_one_won_per_business
  ON public.crm_stages (business_id) WHERE is_won AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS crm_stages_one_lost_per_business
  ON public.crm_stages (business_id) WHERE is_lost AND is_active;

-- 3. Cross-business referential validation -------------------------------
CREATE OR REPLACE FUNCTION public._crm_lead_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.stage_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.crm_stages s
        WHERE s.id = NEW.stage_id AND s.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: stage % does not belong to business %', NEW.stage_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.lost_reason_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.crm_lost_reasons r
        WHERE r.id = NEW.lost_reason_id AND r.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: lost reason % does not belong to business %', NEW.lost_reason_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.id = NEW.contact_id AND c.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: contact % does not belong to business %', NEW.contact_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.company_contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.id = NEW.company_contact_id AND c.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: company contact % does not belong to business %',
      NEW.company_contact_id, NEW.business_id USING ERRCODE = '23514';
  END IF;

  IF NEW.assigned_to IS NOT NULL
     AND NEW.assigned_to IS DISTINCT FROM coalesce(OLD.assigned_to, '00000000-0000-0000-0000-000000000000'::uuid)
     AND NOT public.user_can_access_business(NEW.assigned_to, NEW.business_id) THEN
    RAISE EXCEPTION 'CRM: assignee % is not a member of business %', NEW.assigned_to, NEW.business_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_scope_guard ON public.crm_leads;
CREATE TRIGGER trg_crm_lead_scope_guard
  BEFORE INSERT OR UPDATE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_scope_guard();

-- 4. Lifecycle write guard ------------------------------------------------
CREATE OR REPLACE FUNCTION public._crm_lead_lifecycle_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_rpc boolean := coalesce(current_setting('app.crm_lead_writer', true), '') = '1';
BEGIN
  IF v_rpc THEN
    RETURN NEW;
  END IF;

  IF NEW.status     IS DISTINCT FROM OLD.status
  OR NEW.stage_id   IS DISTINCT FROM OLD.stage_id
  OR NEW.won_at     IS DISTINCT FROM OLD.won_at
  OR NEW.lost_at    IS DISTINCT FROM OLD.lost_at
  OR NEW.probability IS DISTINCT FROM OLD.probability
  OR NEW.is_active  IS DISTINCT FROM OLD.is_active
  OR NEW.type       IS DISTINCT FROM OLD.type
  OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
  OR NEW.lost_reason_id IS DISTINCT FROM OLD.lost_reason_id THEN
    RAISE EXCEPTION
      'CRM: lifecycle fields must be changed through the crm_* transition functions'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('won','lost') AND (
       NEW.expected_revenue   IS DISTINCT FROM OLD.expected_revenue
    OR NEW.contact_id         IS DISTINCT FROM OLD.contact_id
    OR NEW.company_contact_id IS DISTINCT FROM OLD.company_contact_id
    OR NEW.business_id        IS DISTINCT FROM OLD.business_id) THEN
    RAISE EXCEPTION
      'CRM: lead % is % — reopen it before changing value, customer or business', OLD.id, OLD.status
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_lifecycle_write_guard ON public.crm_leads;
CREATE TRIGGER trg_crm_lead_lifecycle_write_guard
  BEFORE UPDATE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_lifecycle_write_guard();

-- 5. Stage deactivation impact guard --------------------------------------
CREATE OR REPLACE FUNCTION public._crm_stage_deactivation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE v_n integer;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    SELECT count(*) INTO v_n
      FROM public.crm_leads l
     WHERE l.stage_id = OLD.id
       AND l.is_active
       AND l.status NOT IN ('won','lost');
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'CRM: stage "%" still holds % open lead(s) — move them to another stage first', OLD.name, v_n
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_stage_deactivation_guard ON public.crm_stages;
CREATE TRIGGER trg_crm_stage_deactivation_guard
  BEFORE UPDATE ON public.crm_stages
  FOR EACH ROW EXECUTE FUNCTION public._crm_stage_deactivation_guard();

-- 6. Transition table + helpers -------------------------------------------
CREATE OR REPLACE FUNCTION public._crm_assert_transition(
  p_from public.crm_lead_status,
  p_to   public.crm_lead_status,
  p_reopen boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF p_from = p_to THEN RETURN; END IF;

  IF p_from IN ('won','lost') THEN
    IF NOT p_reopen THEN
      RAISE EXCEPTION 'CRM: lead is % — use crm_reopen_lead to reopen it', p_from
        USING ERRCODE = '42501';
    END IF;
    IF p_to NOT IN ('new','qualified') THEN
      RAISE EXCEPTION 'CRM: a reopened lead must return to new or qualified (got %)', p_to
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;

  IF p_reopen THEN
    RAISE EXCEPTION 'CRM: lead is not terminal — nothing to reopen' USING ERRCODE = '42501';
  END IF;

  IF NOT (
       (p_from = 'new'         AND p_to IN ('qualified','lost'))
    OR (p_from = 'qualified'   AND p_to IN ('proposition','won','lost'))
    OR (p_from = 'proposition' AND p_to IN ('qualified','won','lost'))
  ) THEN
    RAISE EXCEPTION 'CRM: transition % → % is not allowed', p_from, p_to USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._crm_log_system_activity(
  p_lead public.crm_leads, p_summary text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.crm_activities
    (organization_id, business_id, lead_id, activity_type, summary,
     is_done, completed_at, created_by)
  VALUES
    (p_lead.organization_id, p_lead.business_id, p_lead.id, 'system', p_summary,
     true, now(), auth.uid());
END;
$$;

-- 7. Transition RPCs -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_qualify_lead(p_lead_id uuid)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified');
  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'qualified', type = 'opportunity', updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM public._crm_log_system_activity(v_out, 'Lead qualified into an opportunity');
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_change_stage(p_lead_id uuid, p_stage_id uuid)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
  v_stage public.crm_stages%ROWTYPE; v_old_name text;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead is % — reopen it before moving stage', v_lead.status
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stage FROM public.crm_stages
   WHERE id = p_stage_id AND business_id = v_lead.business_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM: stage % is not an active stage of this business', p_stage_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_stage.is_won OR v_stage.is_lost THEN
    RAISE EXCEPTION 'CRM: use crm_mark_won / crm_mark_lost to reach a terminal stage'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_old_name FROM public.crm_stages WHERE id = v_lead.stage_id;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET stage_id    = p_stage_id,
         probability = coalesce(v_stage.probability, probability),
         status      = CASE WHEN status = 'new' THEN 'qualified'::public.crm_lead_status
                            ELSE status END,
         type        = CASE WHEN status = 'new' THEN 'opportunity' ELSE type END,
         updated_at  = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Stage changed: %s → %s', coalesce(v_old_name,'(none)'), v_stage.name));
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_mark_won(p_lead_id uuid)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_stage uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_transition(v_lead.status, 'won');

  SELECT id INTO v_stage FROM public.crm_stages
   WHERE business_id = v_lead.business_id AND is_won AND is_active;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'won', type = 'opportunity', won_at = now(), lost_at = NULL,
         probability = 100, stage_id = coalesce(v_stage, stage_id), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(v_out, 'Opportunity marked won');
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_mark_lost(
  p_lead_id uuid, p_reason_id uuid DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_stage uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_transition(v_lead.status, 'lost');

  IF p_reason_id IS NULL AND coalesce(btrim(p_notes), '') = '' THEN
    RAISE EXCEPTION 'CRM: a lost reason or explanatory note is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_stage FROM public.crm_stages
   WHERE business_id = v_lead.business_id AND is_lost AND is_active;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'lost', lost_at = now(), won_at = NULL, probability = 0,
         lost_reason_id = p_reason_id, lost_notes = p_notes,
         stage_id = coalesce(v_stage, stage_id), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, coalesce('Opportunity marked lost: ' || nullif(btrim(p_notes), ''),
                    'Opportunity marked lost'));
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_reopen_lead(p_lead_id uuid, p_reason text)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to reopen a closed opportunity'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified', true);

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'qualified', won_at = NULL, lost_at = NULL,
         lost_reason_id = NULL, lost_notes = NULL, probability = 10,
         stage_id = (SELECT id FROM public.crm_stages
                      WHERE business_id = v_lead.business_id AND is_active
                        AND NOT is_won AND NOT is_lost
                      ORDER BY sequence LIMIT 1),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Reopened from %s: %s', v_lead.status, btrim(p_reason)));
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_reassign_lead(p_lead_id uuid, p_assignee uuid)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF p_assignee IS NOT NULL
     AND NOT public.user_can_access_business(p_assignee, v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: assignee is not a member of this business' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads SET assigned_to = p_assignee, updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(v_out, 'Ownership changed');
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_revalue_lead(
  p_lead_id uuid, p_expected_revenue numeric, p_expected_close_date date DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead is % — reopen it before changing its value', v_lead.status
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_revenue IS NOT NULL AND p_expected_revenue < 0 THEN
    RAISE EXCEPTION 'CRM: expected revenue cannot be negative' USING ERRCODE = '22023';
  END IF;

  UPDATE public.crm_leads
     SET expected_revenue = p_expected_revenue,
         expected_close_date = coalesce(p_expected_close_date, expected_close_date),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;

  PERFORM public._crm_log_system_activity(
    v_out, format('Expected revenue changed from %s to %s',
                  coalesce(v_lead.expected_revenue, 0), coalesce(p_expected_revenue, 0)));
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_archive_lead(p_lead_id uuid, p_reason text)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_n integer;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'delete');
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to archive a lead' USING ERRCODE = '22023';
  END IF;

  SELECT (SELECT count(*) FROM public.estimates    WHERE source_lead_id = p_lead_id)
       + (SELECT count(*) FROM public.sales_orders WHERE source_lead_id = p_lead_id)
       + (SELECT count(*) FROM public.projects     WHERE source_lead_id = p_lead_id)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'CRM: lead has % downstream commercial document(s) and cannot be archived', v_n
      USING ERRCODE = '23503';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads SET is_active = false, updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(v_out, 'Lead archived: ' || btrim(p_reason));
  RETURN v_out;
END;
$$;

-- 8. Grants ----------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'crm_qualify_lead(uuid)',
    'crm_change_stage(uuid,uuid)',
    'crm_mark_won(uuid)',
    'crm_mark_lost(uuid,uuid,text)',
    'crm_reopen_lead(uuid,text)',
    'crm_reassign_lead(uuid,uuid)',
    'crm_revalue_lead(uuid,numeric,date)',
    'crm_archive_lead(uuid,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public._crm_log_system_activity(public.crm_leads, text) FROM PUBLIC, anon, authenticated;