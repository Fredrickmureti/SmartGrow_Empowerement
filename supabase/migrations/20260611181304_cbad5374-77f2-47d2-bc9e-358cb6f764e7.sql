
-- =========================================================================
-- Migration 5: approval_rules.requires_review flag
-- =========================================================================
ALTER TABLE public.approval_rules
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_review_reason text;

CREATE OR REPLACE FUNCTION public.flag_approval_rule_self_approver()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.approver_type = 'user'
     AND NEW.approver_user_id IS NOT NULL
     AND NEW.created_by IS NOT NULL
     AND NEW.approver_user_id = NEW.created_by THEN
    NEW.requires_review := true;
    NEW.requires_review_reason :=
      'Rule author is also the named approver. Review whether this rule should designate a different approver to preserve separation of duties.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sod_approval_rule_self_flag ON public.approval_rules;
CREATE TRIGGER sod_approval_rule_self_flag
  BEFORE INSERT OR UPDATE ON public.approval_rules
  FOR EACH ROW EXECUTE FUNCTION public.flag_approval_rule_self_approver();

-- Backfill flag on existing rows.
UPDATE public.approval_rules
   SET requires_review = true,
       requires_review_reason =
         'Rule author is also the named approver. Review whether this rule should designate a different approver to preserve separation of duties.'
 WHERE approver_type = 'user'
   AND approver_user_id IS NOT NULL
   AND created_by IS NOT NULL
   AND approver_user_id = created_by
   AND requires_review = false;

-- =========================================================================
-- Migration 6: approval_history → generic self-approval guard
-- =========================================================================
CREATE OR REPLACE FUNCTION public.guard_approval_history_self()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.approval_requests;
  v_action text;
BEGIN
  IF NEW.approved_by IS NULL OR NEW.request_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_req FROM public.approval_requests WHERE id = NEW.request_id;
  IF NOT FOUND OR v_req.requested_by IS NULL THEN
    RETURN NEW;
  END IF;
  v_action := COALESCE(v_req.entity_type,'generic') || '.approve';
  PERFORM public.governance_assert_not_self(
    NEW.approved_by, v_req.requested_by, v_action,
    v_req.organization_id, v_req.entity_type, v_req.entity_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sod_approval_history_self_guard ON public.approval_history;
CREATE TRIGGER sod_approval_history_self_guard
  BEFORE INSERT ON public.approval_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_approval_history_self();
