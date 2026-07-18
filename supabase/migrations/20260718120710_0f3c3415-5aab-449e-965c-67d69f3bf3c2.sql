
-- 1. Governance duties
INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('credit.approve', 'Approve vendor credit notes', 'procurement',
   'Confirm a draft vendor credit note (posts reversal JE via confirm_vendor_credit_note_atomic).'),
  ('credit.apply',   'Apply vendor credit notes',   'procurement',
   'Allocate a confirmed vendor credit note against one or more open bills (FIFO by due date).')
ON CONFLICT (duty_code) DO NOTHING;

-- 2. SoD conflicts (duty_a < duty_b alphabetical, per CHECK constraint)
INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('bill.approve',  'credit.approve', 'high',
   'Approving both the bill and the credit that offsets it enables collusive reversal without oversight.'),
  ('credit.apply',  'credit.approve', 'high',
   'Applying credit you approved bypasses the reversal review.'),
  ('bill.match',    'credit.apply',   'medium',
   'Matching the bill and then applying credit against it collapses AP into a single-actor loop.')
ON CONFLICT (duty_a, duty_b) DO NOTHING;

-- 3. Event topic registration
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description) VALUES
  ('procurement.credit.applied', 'procurement', ARRAY['finance','audit'],
   'A confirmed vendor credit note has been FIFO-allocated across one or more open bills. Finance uses this to reconcile AP subledger; Audit uses this for the reversal trail.')
ON CONFLICT (topic_prefix) DO NOTHING;

-- 4. Status transition guard on vendor_credit_notes
CREATE OR REPLACE FUNCTION public.guard_vcn_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'     AND NEW.status IN ('confirmed','void')) OR
      (OLD.status = 'confirmed' AND NEW.status IN ('applied','void'))   OR
      (OLD.status = 'applied'   AND NEW.status = 'void')
    ) THEN
      RAISE EXCEPTION 'Invalid vendor credit note status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_guard_vcn_status ON public.vendor_credit_notes;
CREATE TRIGGER tg_guard_vcn_status
  BEFORE UPDATE ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_vcn_status_transition();

-- 5. New canonical FIFO application RPC
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_note_atomic(
  p_credit_note_id uuid,
  p_bill_ids       uuid[] DEFAULT NULL,
  p_user_id        uuid   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vcn              public.vendor_credit_notes%ROWTYPE;
  v_credit_remaining numeric;
  v_bill             record;
  v_bill_balance     numeric;
  v_apply            numeric;
  v_total_applied    numeric := 0;
  v_applications     jsonb   := '[]'::jsonb;
  v_idem             text;
  v_existing_outbox  uuid;
  v_actor            uuid    := COALESCE(p_user_id, auth.uid());
BEGIN
  SELECT * INTO v_vcn FROM public.vendor_credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor credit note % not found', p_credit_note_id USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency short-circuit at this VCN version.
  v_idem := 'credit.applied:' || v_vcn.id::text || ':' ||
            EXTRACT(EPOCH FROM v_vcn.updated_at)::bigint::text;

  SELECT id INTO v_existing_outbox
    FROM public.business_event_outbox
   WHERE idempotency_key = v_idem
   LIMIT 1;

  IF v_existing_outbox IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success',         true,
      'idempotent',      true,
      'outbox_event_id', v_existing_outbox
    );
  END IF;

  IF v_vcn.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only confirmed credit notes can be applied (current status: %)', v_vcn.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Row-level SoD: the confirmer cannot also apply.
  IF v_vcn.created_by IS NOT NULL AND v_vcn.created_by = v_actor THEN
    RAISE EXCEPTION 'SoD violation: the user who confirmed this credit note cannot apply it'
      USING ERRCODE = 'P0001';
  END IF;

  v_credit_remaining := v_vcn.total - v_vcn.amount_applied;
  IF v_credit_remaining <= 0 THEN
    RAISE EXCEPTION 'Credit note has no remaining balance to apply' USING ERRCODE = 'P0001';
  END IF;

  FOR v_bill IN
    SELECT b.id, b.total, b.amount_paid, b.currency, b.due_date, b.created_at
      FROM public.bills b
     WHERE b.organization_id = v_vcn.organization_id
       AND b.business_id     IS NOT DISTINCT FROM v_vcn.business_id
       AND b.vendor_id       = v_vcn.vendor_id
       AND b.currency        = v_vcn.currency
       AND b.status          IN ('received','partial')
       AND (b.total - COALESCE(b.amount_paid, 0)) > 0
       AND (p_bill_ids IS NULL OR b.id = ANY (p_bill_ids))
     ORDER BY b.due_date ASC NULLS LAST, b.created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_credit_remaining <= 0;
    v_bill_balance := v_bill.total - COALESCE(v_bill.amount_paid, 0);
    v_apply        := LEAST(v_credit_remaining, v_bill_balance);

    INSERT INTO public.vendor_credit_note_applications
      (credit_note_id, bill_id, amount, applied_at, applied_by, organization_id, business_id)
    VALUES
      (v_vcn.id, v_bill.id, v_apply, now(), v_actor, v_vcn.organization_id, v_vcn.business_id);

    UPDATE public.bills
       SET amount_paid = COALESCE(amount_paid, 0) + v_apply,
           status = CASE
             WHEN (total - (COALESCE(amount_paid, 0) + v_apply)) <= 0 THEN 'paid'
             ELSE 'partial'
           END,
           updated_at = now()
     WHERE id = v_bill.id;

    v_applications  := v_applications || jsonb_build_array(jsonb_build_object(
      'bill_id',     v_bill.id,
      'amount',      v_apply,
      'new_balance', v_bill_balance - v_apply
    ));
    v_credit_remaining := v_credit_remaining - v_apply;
    v_total_applied    := v_total_applied + v_apply;
  END LOOP;

  IF v_total_applied = 0 THEN
    RAISE EXCEPTION 'No eligible open bills found for FIFO allocation (vendor=%, currency=%)',
      v_vcn.vendor_id, v_vcn.currency USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.vendor_credit_notes
     SET amount_applied = amount_applied + v_total_applied,
         status = CASE
           WHEN (total - (amount_applied + v_total_applied)) <= 0 THEN 'applied'
           ELSE status
         END,
         updated_at = now()
   WHERE id = v_vcn.id;

  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, actor_user_id, source, status)
  VALUES
    (v_vcn.organization_id,
     v_vcn.branch_id,
     'procurement.credit.applied',
     'vendor_credit_note',
     v_vcn.id,
     jsonb_build_object(
       'credit_note_id',     v_vcn.id,
       'credit_note_number', v_vcn.credit_note_number,
       'vendor_id',          v_vcn.vendor_id,
       'currency',           v_vcn.currency,
       'total_applied',      v_total_applied,
       'credit_remaining',   v_credit_remaining,
       'allocations',        v_applications
     ),
     v_idem, v_actor, 'apply_vendor_credit_note_atomic', 'pending');

  RETURN jsonb_build_object(
    'success',          true,
    'total_applied',    v_total_applied,
    'credit_remaining', v_credit_remaining,
    'allocations',      v_applications
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_vendor_credit_note_atomic(uuid, uuid[], uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_vendor_credit_note_atomic(uuid, uuid[], uuid) FROM anon;

-- 6. Retire the legacy single-bill RPC
DROP FUNCTION IF EXISTS public.apply_vendor_credit_atomic(uuid, uuid, numeric, uuid);
