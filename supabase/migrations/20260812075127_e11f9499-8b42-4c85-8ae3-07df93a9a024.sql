-- ------------------------------------------------------------ new columns
ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS commercial_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS accounting_status text NOT NULL DEFAULT 'unposted',
  ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS approval_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vcn_commercial_status_chk') THEN
    ALTER TABLE public.vendor_credit_notes ADD CONSTRAINT vcn_commercial_status_chk
      CHECK (commercial_status IN ('draft','submitted','approved','rejected','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vcn_accounting_status_chk') THEN
    ALTER TABLE public.vendor_credit_notes ADD CONSTRAINT vcn_accounting_status_chk
      CHECK (accounting_status IN ('unposted','posted','reversed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vcn_settlement_status_chk') THEN
    ALTER TABLE public.vendor_credit_notes ADD CONSTRAINT vcn_settlement_status_chk
      CHECK (settlement_status IN ('open','partially_applied','applied','refunded'));
  END IF;
END $$;

-- ------------------------------------------------------------- backfill
UPDATE public.vendor_credit_notes SET
  commercial_status = CASE
    WHEN status = 'void' THEN 'cancelled'
    WHEN status IN ('confirmed','applied','approved') THEN 'approved'
    ELSE 'draft' END,
  accounting_status = CASE
    WHEN status = 'void' THEN 'reversed'
    WHEN status IN ('confirmed','applied') THEN 'posted'
    ELSE 'unposted' END,
  settlement_status = CASE
    WHEN status = 'applied' THEN 'applied'
    WHEN COALESCE(amount_applied,0) > 0 THEN 'partially_applied'
    ELSE 'open' END
WHERE commercial_status = 'draft' AND accounting_status = 'unposted';

-- ------------------------------------------ legacy <-> split status bridge
-- The legacy `status` column stays readable for every existing surface. It is
-- derived from the three real states; if a legacy writer sets it instead, the
-- split columns are mapped back. Exactly one source of truth per write.
CREATE OR REPLACE FUNCTION public._vcn_sync_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE v_derived text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.commercial_status IS NOT DISTINCT FROM OLD.commercial_status
     AND NEW.accounting_status IS NOT DISTINCT FROM OLD.accounting_status
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status THEN
    -- Legacy writer moved `status`: project it onto the split columns.
    NEW.commercial_status := CASE
      WHEN NEW.status = 'void' THEN 'cancelled'
      WHEN NEW.status IN ('confirmed','applied','approved') THEN 'approved'
      ELSE NEW.commercial_status END;
    NEW.accounting_status := CASE
      WHEN NEW.status = 'void' THEN 'reversed'
      WHEN NEW.status IN ('confirmed','applied') THEN 'posted'
      ELSE NEW.accounting_status END;
    NEW.settlement_status := CASE
      WHEN NEW.status = 'applied' THEN 'applied'
      WHEN COALESCE(NEW.amount_applied,0) > 0 THEN 'partially_applied'
      ELSE NEW.settlement_status END;
  END IF;

  v_derived := CASE
    WHEN NEW.accounting_status = 'reversed' OR NEW.commercial_status = 'cancelled' THEN 'void'
    WHEN NEW.accounting_status = 'posted' AND NEW.settlement_status = 'applied' THEN 'applied'
    WHEN NEW.accounting_status = 'posted' THEN 'confirmed'
    ELSE 'draft' END;
  NEW.status := v_derived;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS tg_guard_vcn_status ON public.vendor_credit_notes;
DROP TRIGGER IF EXISTS tg_vcn_sync_status ON public.vendor_credit_notes;
CREATE TRIGGER tg_vcn_sync_status
  BEFORE INSERT OR UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._vcn_sync_status();

-- Transition guard now lives on the real states.
CREATE OR REPLACE FUNCTION public.guard_vcn_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;

  IF NEW.commercial_status IS DISTINCT FROM OLD.commercial_status
     AND NOT (
       (OLD.commercial_status = 'draft'     AND NEW.commercial_status IN ('submitted','approved','cancelled')) OR
       (OLD.commercial_status = 'submitted' AND NEW.commercial_status IN ('approved','rejected','cancelled','draft')) OR
       (OLD.commercial_status = 'rejected'  AND NEW.commercial_status IN ('draft','cancelled')) OR
       (OLD.commercial_status = 'approved'  AND NEW.commercial_status = 'cancelled')
     ) THEN
    RAISE EXCEPTION 'Invalid vendor credit note commercial transition: % -> %',
      OLD.commercial_status, NEW.commercial_status USING ERRCODE='22023';
  END IF;

  IF NEW.accounting_status IS DISTINCT FROM OLD.accounting_status
     AND NOT (
       (OLD.accounting_status = 'unposted' AND NEW.accounting_status = 'posted') OR
       (OLD.accounting_status = 'posted'   AND NEW.accounting_status = 'reversed')
     ) THEN
    RAISE EXCEPTION 'Invalid vendor credit note accounting transition: % -> %',
      OLD.accounting_status, NEW.accounting_status USING ERRCODE='22023';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS tg_guard_vcn_states ON public.vendor_credit_notes;
CREATE TRIGGER tg_guard_vcn_states
  BEFORE UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_vcn_status_transition();

-- --------------------------------------------------- governance helpers
CREATE OR REPLACE FUNCTION public._vcn_requires_approval(_org_id uuid, _business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.approval_rules r
     WHERE r.is_active
       AND r.organization_id = _org_id
       AND (r.business_id IS NULL OR r.business_id = _business_id)
       AND r.entity_type IN ('vendor_credit_note','vendor_credit_notes')
  );
$fn$;

CREATE OR REPLACE FUNCTION public._vcn_load(_id uuid)
RETURNS public.vendor_credit_notes
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = _id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor credit note % not found', _id USING ERRCODE='P0002'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v.business_id USING ERRCODE='42501';
  END IF;
  RETURN v;
END
$fn$;

-- ------------------------------------------------------ lifecycle writers
CREATE OR REPLACE FUNCTION public.vendor_credit_note_submit(_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes; v_req public.approval_requests;
BEGIN
  v := public._vcn_load(_id);
  IF v.commercial_status NOT IN ('draft','rejected') THEN
    RAISE EXCEPTION 'Only a draft vendor credit note can be submitted (current: %)', v.commercial_status
      USING ERRCODE='22023';
  END IF;
  IF COALESCE(v.total,0) <= 0 THEN
    RAISE EXCEPTION 'This credit note has no value to submit' USING ERRCODE='22023';
  END IF;

  UPDATE public.vendor_credit_notes
     SET commercial_status='submitted', submitted_at=now(), submitted_by=auth.uid(),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;

  v_req := public.approval_route(
    'vendor_credit_note.approve', 'vendor_credit_note', _id, v.credit_note_number,
    jsonb_build_object('amount', v.total, 'total_amount', v.total,
                       'currency', v.currency, 'vendor_id', v.vendor_id,
                       'bill_id', v.bill_id, 'origin', v.origin,
                       'reason_code', v.reason_code),
    jsonb_build_object('organization_id', v.organization_id),
    'vendor_credit_note.approve:' || _id::text || ':v' || (v.row_version + 1)::text,
    v.business_id);

  IF v_req.id IS NOT NULL THEN
    UPDATE public.vendor_credit_notes SET approval_request_id = v_req.id, updated_at=now() WHERE id=_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'gated', v_req.id IS NOT NULL,
                            'approval_request_id', v_req.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.vendor_credit_note_approve(_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes;
BEGIN
  v := public._vcn_load(_id);
  IF v.commercial_status NOT IN ('draft','submitted') THEN
    RAISE EXCEPTION 'Vendor credit note is %, it cannot be approved', v.commercial_status
      USING ERRCODE='22023';
  END IF;

  -- Segregation of duties: approving your own credit note needs an override.
  PERFORM public.governance_assert_not_self(
    auth.uid(), v.created_by, 'vendor_credit_note.approve',
    v.organization_id, 'vendor_credit_note', v.id);

  UPDATE public.vendor_credit_notes
     SET commercial_status='approved', approved_by=auth.uid(), approved_at=now(),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;

  RETURN jsonb_build_object('success', true);
END
$fn$;

CREATE OR REPLACE FUNCTION public.vendor_credit_note_reject(_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes;
BEGIN
  v := public._vcn_load(_id);
  IF v.commercial_status <> 'submitted' THEN
    RAISE EXCEPTION 'Only a submitted vendor credit note can be rejected (current: %)', v.commercial_status
      USING ERRCODE='22023';
  END IF;
  UPDATE public.vendor_credit_notes
     SET commercial_status='rejected', rejected_by=auth.uid(), rejected_at=now(),
         rejected_reason=COALESCE(_reason,'Rejected'), approval_request_id=NULL,
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  RETURN jsonb_build_object('success', true);
END
$fn$;

CREATE OR REPLACE FUNCTION public.vendor_credit_note_cancel(_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes;
BEGIN
  v := public._vcn_load(_id);
  IF v.accounting_status = 'posted' THEN
    RAISE EXCEPTION 'A posted vendor credit note must be reversed, not cancelled' USING ERRCODE='22023';
  END IF;
  IF v.commercial_status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already', true);
  END IF;
  UPDATE public.vendor_credit_notes
     SET commercial_status='cancelled', cancelled_by=auth.uid(), cancelled_at=now(),
         notes = COALESCE(notes,'') || COALESCE(E'\nCancelled: ' || _reason, ''),
         approval_request_id=NULL, row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  RETURN jsonb_build_object('success', true);
END
$fn$;

-- ------------------------------------- mirror engine decisions back onto it
CREATE OR REPLACE FUNCTION public._mirror_approval_to_vendor_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v public.vendor_credit_notes; v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'vendor_credit_note' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v FROM public.vendor_credit_notes WHERE id = NEW.entity_id;
  IF v.id IS NULL OR v.commercial_status <> 'submitted' THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.status = 'approved' THEN
    UPDATE public.vendor_credit_notes
       SET commercial_status='approved', approved_by=v_actor, approved_at=now(),
           row_version=row_version+1, updated_at=now()
     WHERE id = v.id;
  ELSIF NEW.status IN ('rejected','cancelled') THEN
    UPDATE public.vendor_credit_notes
       SET commercial_status='rejected', rejected_by=v_actor, rejected_at=now(),
           rejected_reason=COALESCE(rejected_reason,'Rejected via governance engine'),
           approval_request_id=NULL, row_version=row_version+1, updated_at=now()
     WHERE id = v.id;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_vendor_credit_note ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_vendor_credit_note
  AFTER INSERT OR UPDATE ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_vendor_credit_note();

-- ------------------------------------------------------- retire the legacy
DROP FUNCTION IF EXISTS public.approve_vendor_credit_note(uuid);

GRANT EXECUTE ON FUNCTION public.vendor_credit_note_submit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_credit_note_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_credit_note_reject(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_credit_note_cancel(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._vcn_requires_approval(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';