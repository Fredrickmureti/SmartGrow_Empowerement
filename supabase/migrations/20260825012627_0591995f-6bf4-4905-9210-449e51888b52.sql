-- ===========================================================================
-- CRM Phase R1 · Lifecycle completion
--   1. Lifecycle timestamps + reopen/archive provenance + row version
--   2. Optimistic concurrency on every lifecycle RPC
--   3. proposition state made reachable and reversible
--   4. Archive/restore semantics with provenance
--   5. Pipeline configuration gated on a dedicated admin capability
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS qualified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS proposition_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopen_reason   text,
  ADD COLUMN IF NOT EXISTS archived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by     uuid,
  ADD COLUMN IF NOT EXISTS archive_reason  text,
  ADD COLUMN IF NOT EXISTS version         integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.crm_leads.version IS
  'Server-owned optimistic-concurrency token. Bumped by trigger on every UPDATE; client values are ignored.';
COMMENT ON COLUMN public.crm_leads.archived_at IS
  'Set by crm_archive_lead, cleared by crm_restore_lead. is_active=false <-> archived_at is not null.';

-- Backfill from the immutable history so the new columns are not fiction.
UPDATE public.crm_leads l
   SET qualified_at = COALESCE(
         (SELECT min(h.occurred_at) FROM public.crm_lead_history h
           WHERE h.lead_id = l.id AND h.to_status = 'qualified'),
         l.created_at)
 WHERE l.qualified_at IS NULL
   AND l.status <> 'new';

UPDATE public.crm_leads l
   SET proposition_at = (SELECT min(h.occurred_at) FROM public.crm_lead_history h
                          WHERE h.lead_id = l.id AND h.to_status = 'proposition')
 WHERE l.proposition_at IS NULL;

UPDATE public.crm_leads l
   SET reopen_count  = r.n,
       reopened_at   = r.last_at,
       reopen_reason = r.last_reason
  FROM (SELECT h.lead_id,
               count(*)                                      AS n,
               max(h.occurred_at)                            AS last_at,
               (array_agg(h.reason ORDER BY h.occurred_at DESC))[1] AS last_reason
          FROM public.crm_lead_history h
         WHERE h.event = 'reopened'
         GROUP BY h.lead_id) r
 WHERE r.lead_id = l.id;

UPDATE public.crm_leads l
   SET archived_at    = COALESCE(l.archived_at, a.at, l.updated_at),
       archive_reason = COALESCE(l.archive_reason, a.reason)
  FROM (SELECT h.lead_id,
               max(h.occurred_at)                                   AS at,
               (array_agg(h.reason ORDER BY h.occurred_at DESC))[1]  AS reason
          FROM public.crm_lead_history h
         WHERE h.event = 'archived'
         GROUP BY h.lead_id) a
 WHERE a.lead_id = l.id AND l.is_active = false;

UPDATE public.crm_leads
   SET archived_at = updated_at
 WHERE is_active = false AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Version bump: server-owned, client value never trusted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._crm_lead_version_bump()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_leads_version_bump ON public.crm_leads;
CREATE TRIGGER crm_leads_version_bump
BEFORE UPDATE ON public.crm_leads
FOR EACH ROW EXECUTE FUNCTION public._crm_lead_version_bump();

CREATE OR REPLACE FUNCTION public._crm_assert_version(p_actual integer, p_expected integer)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM p_actual THEN
    RAISE EXCEPTION
      'CRM: this opportunity was changed by someone else (expected version %, current %) — reload and retry',
      p_expected, p_actual
      USING ERRCODE = '40001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Lifecycle write guard: the new server-owned columns are off limits
-- ---------------------------------------------------------------------------
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
  OR NEW.branch_id  IS DISTINCT FROM OLD.branch_id
  OR NEW.lost_reason_id IS DISTINCT FROM OLD.lost_reason_id
  OR NEW.qualified_at   IS DISTINCT FROM OLD.qualified_at
  OR NEW.proposition_at IS DISTINCT FROM OLD.proposition_at
  OR NEW.reopened_at    IS DISTINCT FROM OLD.reopened_at
  OR NEW.reopen_count   IS DISTINCT FROM OLD.reopen_count
  OR NEW.reopen_reason  IS DISTINCT FROM OLD.reopen_reason
  OR NEW.archived_at    IS DISTINCT FROM OLD.archived_at
  OR NEW.archived_by    IS DISTINCT FROM OLD.archived_by
  OR NEW.archive_reason IS DISTINCT FROM OLD.archive_reason THEN
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

  IF OLD.is_active = false THEN
    RAISE EXCEPTION
      'CRM: lead % is archived — restore it before editing', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. History: recognise proposition, withdrawal and restore
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._crm_lead_history_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text := nullif(btrim(coalesce(current_setting('app.crm_lead_reason', true), '')), '');
  v_events text[] := ARRAY[]::text[];
  v_e text;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_events := array_append(v_events, 'archived');
  ELSIF NOT OLD.is_active AND NEW.is_active THEN
    v_events := array_append(v_events, 'restored');
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'won' THEN
      v_events := array_append(v_events, 'won');
    ELSIF NEW.status = 'lost' THEN
      v_events := array_append(v_events, 'lost');
    ELSIF OLD.status IN ('won','lost') THEN
      v_events := array_append(v_events, 'reopened');
    ELSIF NEW.status = 'proposition' THEN
      v_events := array_append(v_events, 'proposition');
    ELSIF OLD.status = 'proposition' AND NEW.status = 'qualified' THEN
      v_events := array_append(v_events, 'proposition_withdrawn');
    ELSIF OLD.status = 'new' AND NEW.status = 'qualified' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
      v_events := array_append(v_events, 'qualified');
    ELSE
      v_events := array_append(v_events, 'stage_changed');
    END IF;
  ELSIF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN
    v_events := array_append(v_events, 'stage_changed');
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    v_events := array_append(v_events, 'reassigned');
  END IF;
  IF coalesce(OLD.expected_revenue, 0) IS DISTINCT FROM coalesce(NEW.expected_revenue, 0) THEN
    v_events := array_append(v_events, 'revalued');
  END IF;
  IF OLD.branch_id IS DISTINCT FROM NEW.branch_id THEN
    v_events := array_append(v_events, 'branch_transferred');
  END IF;

  IF array_length(v_events, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH v_e IN ARRAY v_events LOOP
    INSERT INTO public.crm_lead_history (
      organization_id, business_id, lead_id, event,
      from_status, to_status, from_stage_id, to_stage_id,
      from_value, to_value, from_assignee, to_assignee,
      branch_id, from_branch_id, to_branch_id,
      reason, metadata, actor_user_id, occurred_at)
    VALUES (
      NEW.organization_id, NEW.business_id, NEW.id, v_e,
      OLD.status, NEW.status, OLD.stage_id, NEW.stage_id,
      OLD.expected_revenue, NEW.expected_revenue, OLD.assigned_to, NEW.assigned_to,
      NEW.branch_id, OLD.branch_id, NEW.branch_id,
      v_reason,
      jsonb_build_object(
        'type', NEW.type,
        'probability', NEW.probability,
        'is_active', NEW.is_active,
        'lost_reason_id', NEW.lost_reason_id,
        'expected_close_date', NEW.expected_close_date,
        'version', NEW.version,
        'reopen_count', NEW.reopen_count),
      auth.uid(), clock_timestamp());
  END LOOP;

  RETURN NEW;
END;
$$;

-- New lifecycle topics (dispatcher registry is closed; see outbox-dispatcher).
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, description, consumer_domains, integration_only)
VALUES
  ('crm.lead.proposition', 'crm',
   'Opportunity moved into proposition (offer outstanding).', ARRAY[]::text[], true),
  ('crm.lead.proposition_withdrawn', 'crm',
   'Proposition withdrawn; opportunity returned to qualified.', ARRAY[]::text[], true),
  ('crm.lead.restored', 'crm',
   'Archived lead restored to the active pipeline.', ARRAY[]::text[], true)
ON CONFLICT (topic_prefix) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Transition RPCs — recreated with optimistic concurrency
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.crm_qualify_lead(uuid);
CREATE FUNCTION public.crm_qualify_lead(p_lead_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified');
  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'qualified', type = 'opportunity',
         qualified_at = coalesce(qualified_at, now()), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM public._crm_log_system_activity(v_out, 'Lead qualified into an opportunity');
  RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS public.crm_change_stage(uuid, uuid);
CREATE FUNCTION public.crm_change_stage(p_lead_id uuid, p_stage_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
  v_stage public.crm_stages%ROWTYPE; v_old_name text;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
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
         qualified_at = CASE WHEN status = 'new' THEN coalesce(qualified_at, now()) ELSE qualified_at END,
         updated_at  = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Stage changed: %s → %s', coalesce(v_old_name,'(none)'), v_stage.name));
  RETURN v_out;
END;
$$;

-- proposition: the middle of the lifecycle becomes reachable
CREATE OR REPLACE FUNCTION public.crm_mark_proposition(p_lead_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  PERFORM public._crm_assert_transition(v_lead.status, 'proposition');

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'proposition', type = 'opportunity',
         proposition_at = coalesce(proposition_at, now()),
         qualified_at   = coalesce(qualified_at, now()),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(v_out, 'Proposition issued to the customer');
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_withdraw_proposition(
  p_lead_id uuid, p_reason text, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  IF v_lead.status <> 'proposition' THEN
    RAISE EXCEPTION 'CRM: lead is % — there is no outstanding proposition to withdraw', v_lead.status
      USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to withdraw a proposition' USING ERRCODE = '22023';
  END IF;
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified');

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads
     SET status = 'qualified', proposition_at = NULL, updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(v_out, 'Proposition withdrawn: ' || btrim(p_reason));
  RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS public.crm_mark_won(uuid);
CREATE FUNCTION public.crm_mark_won(p_lead_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_stage uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  PERFORM public._crm_assert_transition(v_lead.status, 'won');

  SELECT id INTO v_stage FROM public.crm_stages
   WHERE business_id = v_lead.business_id AND is_won AND is_active;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET status = 'won', type = 'opportunity', won_at = now(), lost_at = NULL,
         probability = 100, stage_id = coalesce(v_stage, stage_id),
         qualified_at = coalesce(qualified_at, now()), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(v_out, 'Opportunity marked won');
  RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS public.crm_mark_lost(uuid, uuid, text);
CREATE FUNCTION public.crm_mark_lost(
  p_lead_id uuid, p_reason_id uuid DEFAULT NULL, p_notes text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_stage uuid; v_reason text;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  PERFORM public._crm_assert_transition(v_lead.status, 'lost');

  IF p_reason_id IS NULL AND coalesce(btrim(p_notes), '') = '' THEN
    RAISE EXCEPTION 'CRM: a lost reason or explanatory note is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_stage FROM public.crm_stages
   WHERE business_id = v_lead.business_id AND is_lost AND is_active;

  v_reason := coalesce(nullif(btrim(coalesce(p_notes, '')), ''),
                       (SELECT name FROM public.crm_lost_reasons WHERE id = p_reason_id));

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', coalesce(v_reason, ''), true);
  UPDATE public.crm_leads
     SET status = 'lost', lost_at = now(), won_at = NULL, probability = 0,
         lost_reason_id = p_reason_id, lost_notes = p_notes,
         stage_id = coalesce(v_stage, stage_id), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(
    v_out, coalesce('Opportunity marked lost: ' || nullif(btrim(p_notes), ''),
                    'Opportunity marked lost'));
  RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS public.crm_reopen_lead(uuid, text);
CREATE FUNCTION public.crm_reopen_lead(
  p_lead_id uuid, p_reason text, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to reopen a closed opportunity'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._crm_assert_transition(v_lead.status, 'qualified', true);

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads
     SET status = 'qualified', won_at = NULL, lost_at = NULL,
         lost_reason_id = NULL, lost_notes = NULL, probability = 10,
         proposition_at = NULL,
         reopened_at = now(),
         reopen_count = reopen_count + 1,
         reopen_reason = btrim(p_reason),
         stage_id = (SELECT id FROM public.crm_stages
                      WHERE business_id = v_lead.business_id AND is_active
                        AND NOT is_won AND NOT is_lost
                      ORDER BY sequence LIMIT 1),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Reopened from %s: %s', v_lead.status, btrim(p_reason)));
  RETURN v_out;
END;
$$;

DROP FUNCTION IF EXISTS public.crm_reassign_lead(uuid, uuid);
CREATE FUNCTION public.crm_reassign_lead(
  p_lead_id uuid, p_assignee uuid, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
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

DROP FUNCTION IF EXISTS public.crm_revalue_lead(uuid, numeric, date);
CREATE FUNCTION public.crm_revalue_lead(
  p_lead_id uuid, p_expected_revenue numeric, p_expected_close_date date DEFAULT NULL,
  p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'update');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead is % — reopen it before changing its value', v_lead.status
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_revenue IS NOT NULL AND p_expected_revenue < 0 THEN
    RAISE EXCEPTION 'CRM: expected revenue cannot be negative' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET expected_revenue = p_expected_revenue,
         expected_close_date = coalesce(p_expected_close_date, expected_close_date),
         updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  PERFORM public._crm_log_system_activity(
    v_out, format('Expected revenue changed from %s to %s',
                  coalesce(v_lead.expected_revenue, 0), coalesce(p_expected_revenue, 0)));
  RETURN v_out;
END;
$$;

-- Archive gains provenance; restore is its documented inverse.
DROP FUNCTION IF EXISTS public.crm_archive_lead(uuid, text);
CREATE FUNCTION public.crm_archive_lead(
  p_lead_id uuid, p_reason text, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE; v_n integer;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'delete');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to archive a lead' USING ERRCODE = '22023';
  END IF;
  IF NOT v_lead.is_active THEN
    RAISE EXCEPTION 'CRM: lead % is already archived', p_lead_id USING ERRCODE = '42501';
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
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads
     SET is_active = false, archived_at = now(), archived_by = auth.uid(),
         archive_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(v_out, 'Lead archived: ' || btrim(p_reason));
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_restore_lead(
  p_lead_id uuid, p_reason text, p_expected_version integer DEFAULT NULL)
RETURNS public.crm_leads
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_lead public.crm_leads%ROWTYPE; v_out public.crm_leads%ROWTYPE;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'delete');
  PERFORM public._crm_assert_version(v_lead.version, p_expected_version);
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'CRM: a reason is required to restore a lead' USING ERRCODE = '22023';
  END IF;
  IF v_lead.is_active THEN
    RAISE EXCEPTION 'CRM: lead % is not archived', p_lead_id USING ERRCODE = '42501';
  END IF;
  IF v_lead.status IN ('won','lost') THEN
    RAISE EXCEPTION 'CRM: lead % is % — a closed opportunity cannot be restored to the pipeline', p_lead_id, v_lead.status
      USING ERRCODE = '42501';
  END IF;
  IF v_lead.stage_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.crm_stages s
                      WHERE s.id = v_lead.stage_id AND s.is_active
                        AND s.business_id = v_lead.business_id) THEN
    RAISE EXCEPTION 'CRM: the stage this lead was archived in is no longer active — reconfigure the pipeline first'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('app.crm_lead_writer', '1', true);
  PERFORM set_config('app.crm_lead_reason', btrim(p_reason), true);
  UPDATE public.crm_leads
     SET is_active = true, archived_at = NULL, archived_by = NULL,
         archive_reason = NULL, updated_at = now()
   WHERE id = p_lead_id RETURNING * INTO v_out;
  PERFORM set_config('app.crm_lead_writer', '0', true);
  PERFORM set_config('app.crm_lead_reason', '', true);

  PERFORM public._crm_log_system_activity(v_out, 'Lead restored: ' || btrim(p_reason));
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_qualify_lead(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_change_stage(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_mark_proposition(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_withdraw_proposition(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_mark_won(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_mark_lost(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_reopen_lead(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_reassign_lead(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_revalue_lead(uuid, numeric, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_archive_lead(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_restore_lead(uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.crm_qualify_lead(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_change_stage(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_mark_proposition(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_withdraw_proposition(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_mark_won(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_mark_lost(uuid, uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_reopen_lead(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_reassign_lead(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_revalue_lead(uuid, numeric, date, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_archive_lead(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_restore_lead(uuid, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Pipeline configuration is an administration capability, not day-to-day sales
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_can_admin_pipeline(
  _user_id uuid, _org_id uuid, _business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _user_id IS NOT NULL
     AND public.user_can_access_business(_user_id, _business_id)
     AND public.user_has_module_permission(_user_id, _org_id, _business_id, 'settings', 'write');
$$;

REVOKE ALL ON FUNCTION public.crm_can_admin_pipeline(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_can_admin_pipeline(uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS crm_stages_insert_v2 ON public.crm_stages;
DROP POLICY IF EXISTS crm_stages_update_v2 ON public.crm_stages;
DROP POLICY IF EXISTS crm_stages_delete_v2 ON public.crm_stages;

CREATE POLICY crm_stages_insert_v3 ON public.crm_stages
FOR INSERT TO authenticated
WITH CHECK (
  public.crm_can_admin_pipeline(auth.uid(), organization_id, business_id)
  AND (branch_id IS NULL
       OR public.user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY crm_stages_update_v3 ON public.crm_stages
FOR UPDATE TO authenticated
USING (
  public.crm_can_admin_pipeline(auth.uid(), organization_id, business_id)
  AND (branch_id IS NULL
       OR public.user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
)
WITH CHECK (
  public.crm_can_admin_pipeline(auth.uid(), organization_id, business_id)
  AND (branch_id IS NULL
       OR public.user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);

CREATE POLICY crm_stages_delete_v3 ON public.crm_stages
FOR DELETE TO authenticated
USING (
  public.crm_can_admin_pipeline(auth.uid(), organization_id, business_id)
  AND (branch_id IS NULL
       OR public.user_can_access_branch(auth.uid(), branch_id)
       OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id))
);
