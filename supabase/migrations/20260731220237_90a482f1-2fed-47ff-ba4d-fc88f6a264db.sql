-- Governance teardown: detect an active reset without needing a parent row.
CREATE OR REPLACE FUNCTION public._is_teardown_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.reset_in_progress', true), ''), '') <> ''
$$;

GRANT EXECUTE ON FUNCTION public._is_teardown_active() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._approval_history_chain()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev_seq  bigint;
  v_prev_hash text;
  v_material  text;
  v_org       uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Governance-plane bypass: a privileged workspace teardown is
    -- allowed to remove/adjust hash-chain rows because the parent
    -- approval_requests row is being deleted in the same transaction.
    --
    -- NOTE: on an ON DELETE CASCADE the parent row is already gone by the
    -- time this trigger fires, so the org lookup returns NULL. In that
    -- case fall back to the txn-local teardown GUC being set at all.
    v_org := (SELECT organization_id FROM public.approval_requests
               WHERE id = COALESCE(NEW.request_id, OLD.request_id));

    IF (v_org IS NOT NULL AND public._is_teardown_for_org(v_org))
       OR (v_org IS NULL AND public._is_teardown_active()) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'approval_history is append-only'
        USING ERRCODE = '42501', HINT = 'GOV_APPEND_ONLY';
    END IF;
    IF NEW.event_seq   IS DISTINCT FROM OLD.event_seq
       OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
       OR NEW.event_hash IS DISTINCT FROM OLD.event_hash
       OR NEW.payload    IS DISTINCT FROM OLD.payload
       OR NEW.action     IS DISTINCT FROM OLD.action
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.recorded_at   IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'approval_history rows are immutable'
        USING ERRCODE = '42501', HINT = 'GOV_APPEND_ONLY';
    END IF;
    RETURN NEW;
  END IF;

  SELECT event_seq, event_hash
    INTO v_prev_seq, v_prev_hash
    FROM public.approval_history
   WHERE request_id = NEW.request_id
   ORDER BY event_seq DESC
   LIMIT 1;

  NEW.event_seq := COALESCE(v_prev_seq, 0) + 1;
  NEW.prev_hash := v_prev_hash;
  IF NEW.recorded_at IS NULL THEN
    NEW.recorded_at := now();
  END IF;

  v_material := NEW.request_id::text
             || '|' || NEW.event_seq::text
             || '|' || COALESCE(NEW.event_type,'')
             || '|' || COALESCE(NEW.action,'')
             || '|' || COALESCE(NEW.actor_user_id::text,'')
             || '|' || COALESCE(NEW.prev_hash,'')
             || '|' || COALESCE(NEW.payload::text,'{}')
             || '|' || NEW.recorded_at::text;

  NEW.event_hash := encode(digest(v_material, 'sha256'), 'hex');
  RETURN NEW;
END;
$function$;

-- Belt and braces: the reset module should clear approval history for the
-- org explicitly (inside teardown context) before removing the requests.
CREATE OR REPLACE FUNCTION public.reset_module__ancillaries(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.customer_statements') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM customer_statements WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('customer_statements', n);
  END IF;
  IF to_regclass('public.etims_transmission_logs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM etims_transmission_logs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('etims_transmission_logs', n);
  END IF;
  IF to_regclass('public.payment_requests') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payment_requests WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payment_requests', n);
  END IF;
  IF to_regclass('public.approval_requests') IS NOT NULL THEN
    IF to_regclass('public.approval_history') IS NOT NULL THEN
      EXECUTE format(
        'WITH d AS (DELETE FROM approval_history h USING approval_requests r WHERE h.request_id = r.id AND r.organization_id=%L RETURNING 1) SELECT count(*) FROM d',
        org_id) INTO n;
      v := v || jsonb_build_object('approval_history', n);
    END IF;
    IF to_regclass('public.approval_rule_logs') IS NOT NULL THEN
      EXECUTE format('WITH d AS (DELETE FROM approval_rule_logs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
      v := v || jsonb_build_object('approval_rule_logs', n);
    END IF;
    EXECUTE format('WITH d AS (DELETE FROM approval_requests WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('approval_requests', n);
  END IF;
  RETURN v;
END; $function$;