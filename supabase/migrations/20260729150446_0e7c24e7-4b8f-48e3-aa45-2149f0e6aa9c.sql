-- Extend the approval_history hash-chain trigger with the same
-- teardown bypass used by every other operational-immutability guard
-- (stock-adjustment, sales-order, JE, etc.). During a privileged
-- reset_organization_data run the txn-local GUC `app.reset_in_progress`
-- is set to the org id; only in that transaction do we allow DELETE
-- (cascaded from approval_requests) / UPDATE on approval_history.
CREATE OR REPLACE FUNCTION public._approval_history_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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
    v_org := COALESCE(
      (SELECT organization_id FROM public.approval_requests
        WHERE id = COALESCE(NEW.request_id, OLD.request_id)),
      NULL
    );
    IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
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
$$;