-- =====================================================================
-- Phase 5.3 — Reversal approval thresholds
-- Reuses the existing approval engine (governance_action_registry →
-- approval_route → approval_decide). No second approval implementation.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.reversal_approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NULL,
  document_type text NOT NULL,
  amount_threshold numeric NULL,
  require_for_prior_period boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reversal_approval_policies TO authenticated;
GRANT ALL ON public.reversal_approval_policies TO service_role;

ALTER TABLE public.reversal_approval_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view reversal approval policies"
  ON public.reversal_approval_policies FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(organization_id));

CREATE POLICY "Org members can manage reversal approval policies"
  ON public.reversal_approval_policies FOR ALL TO authenticated
  USING (public.user_belongs_to_org(organization_id))
  WITH CHECK (public.user_belongs_to_org(organization_id));

CREATE UNIQUE INDEX IF NOT EXISTS reversal_approval_policies_org_biz_doc_uq
  ON public.reversal_approval_policies (
    organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), document_type);

CREATE TRIGGER trg_reversal_approval_policies_touch
  BEFORE UPDATE ON public.reversal_approval_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- Governance registry entries: one action key per reversible document.
-- ---------------------------------------------------------------------
INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description,
   severity_default, is_active, requires_approval_always)
VALUES
  ('reversal.invoice','sales','invoices','from_entity','Approve invoice reversal',
   'Voiding or crediting a posted customer invoice.','high',true,false),
  ('reversal.payment','sales','payments','from_entity','Approve customer payment reversal',
   'Voiding, unapplying or refunding a customer receipt.','high',true,false),
  ('reversal.bill','purchases','bills','from_entity','Approve supplier bill reversal',
   'Voiding a posted supplier bill.','high',true,false),
  ('reversal.bill_payment','purchases','bill_payments','from_entity','Approve supplier payment reversal',
   'Voiding a payment made to a supplier.','high',true,false),
  ('reversal.goods_receipt','purchases','goods_receipts','from_entity','Approve goods receipt reversal',
   'Returning received goods and unwinding the receipt postings.','high',true,false)
ON CONFLICT (action_key) DO UPDATE
  SET module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_active = true;

-- ---------------------------------------------------------------------
-- Requirement resolver. One place decides whether a reversal is gated,
-- and whether that gate has already been satisfied.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reversal_approval_requirement(
  _document_type text,
  _document_id uuid,
  _operation text DEFAULT 'void',
  _effective_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent     jsonb;
  v_org        uuid;
  v_biz        uuid;
  v_amount     numeric;
  v_policy     public.reversal_approval_policies%ROWTYPE;
  v_action     text := 'reversal.' || _document_type;
  v_date       date := COALESCE(_effective_date, CURRENT_DATE);
  v_prior      boolean;
  v_required   boolean := false;
  v_reasons    text[] := ARRAY[]::text[];
  v_req        public.approval_requests%ROWTYPE;
BEGIN
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);
  v_org    := NULLIF(v_intent->>'organization_id','')::uuid;
  v_biz    := NULLIF(v_intent->>'business_id','')::uuid;
  v_amount := COALESCE((v_intent->>'total')::numeric, 0);

  SELECT * INTO v_policy
    FROM public.reversal_approval_policies
   WHERE organization_id = v_org
     AND document_type = _document_type
     AND is_active
     AND (business_id = v_biz OR business_id IS NULL)
   ORDER BY (business_id IS NOT NULL) DESC
   LIMIT 1;

  -- "Prior period" is anything dated before the month the reversal is being
  -- posted into: those touch already-reported numbers.
  v_prior := v_date < date_trunc('month', CURRENT_DATE)::date;

  IF v_policy.id IS NOT NULL THEN
    IF v_policy.amount_threshold IS NOT NULL AND v_amount >= v_policy.amount_threshold THEN
      v_required := true;
      v_reasons  := v_reasons || ('Value of ' || round(v_amount, 2) ||
                    ' is at or above the approval threshold of ' ||
                    round(v_policy.amount_threshold, 2) || '.');
    END IF;
    IF v_policy.require_for_prior_period AND v_prior THEN
      v_required := true;
      v_reasons  := v_reasons || 'The reversal is dated in a prior accounting period.';
    END IF;
  END IF;

  SELECT * INTO v_req
    FROM public.approval_requests
   WHERE organization_id = v_org
     AND action_key = v_action
     AND entity_type = _document_type
     AND entity_id = _document_id
   ORDER BY created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'document_type',   _document_type,
    'document_id',     _document_id,
    'operation',       _operation,
    'action_key',      v_action,
    'amount',          v_amount,
    'required',        v_required,
    'reasons',         to_jsonb(v_reasons),
    'policy_id',       v_policy.id,
    'amount_threshold', v_policy.amount_threshold,
    'request_id',      v_req.id,
    'request_status',  v_req.status,
    'satisfied',       (NOT v_required) OR COALESCE(v_req.status = 'approved', false));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reversal_approval_requirement(text, uuid, text, date) TO authenticated;

-- ---------------------------------------------------------------------
-- Raise the approval request. Reason is validated up front so an approver
-- never sees a request that the writer would later refuse.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_reversal_approval(
  _document_type text,
  _document_id uuid,
  _operation text,
  _reason_code text,
  _comment text DEFAULT NULL,
  _effective_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent jsonb;
  v_need   jsonb;
  v_req    public.approval_requests;
BEGIN
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);
  PERFORM public.assert_reversal_reason(_document_type, _reason_code, _comment);

  v_need := public.reversal_approval_requirement(
              _document_type, _document_id, _operation, _effective_date);

  IF NOT COALESCE((v_need->>'required')::boolean, false) THEN
    RAISE EXCEPTION 'This reversal does not need approval — reverse it directly.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE((v_need->>'satisfied')::boolean, false) THEN
    RETURN v_need;
  END IF;

  v_req := public.approval_route(
    _action_key       => v_need->>'action_key',
    _entity_type      => _document_type,
    _entity_id        => _document_id,
    _entity_reference => v_intent->>'document_number',
    _payload          => jsonb_build_object(
                           'operation', _operation,
                           'reason_code', _reason_code,
                           'comment', _comment,
                           'amount', v_need->'amount',
                           'effective_date', _effective_date,
                           'message', _comment),
    _context          => jsonb_build_object(
                           'organization_id', v_intent->>'organization_id',
                           'reasons', v_need->'reasons'),
    _idempotency_key  => 'reversal:' || _document_type || ':' || _document_id::text
                         || ':' || _operation,
    _business_id      => NULLIF(v_intent->>'business_id','')::uuid);

  RETURN public.reversal_approval_requirement(
           _document_type, _document_id, _operation, _effective_date);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_reversal_approval(text, uuid, text, text, text, date) TO authenticated;

-- ---------------------------------------------------------------------
-- The gate now also enforces the approval policy. One gate, one answer.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_can_reverse(
  _document_type text,
  _document_id uuid,
  _operation text,
  _actor uuid DEFAULT NULL::uuid,
  _effective_date date DEFAULT NULL::date
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent   jsonb;
  v_op       jsonb;
  v_biz      uuid;
  v_date     date := COALESCE(_effective_date, CURRENT_DATE);
  v_number   text;
  v_need     jsonb;
BEGIN
  IF _document_type IS NULL OR _document_id IS NULL OR _operation IS NULL THEN
    RAISE EXCEPTION 'assert_can_reverse requires a document type, id and operation'
      USING ERRCODE = '22023';
  END IF;

  -- Legality + caller authorization live in the intent authority. It raises
  -- 42501 when the caller does not belong to the document's organization and
  -- P0002 when the document does not exist.
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);

  v_number := COALESCE(v_intent->>'document_number', _document_id::text);
  v_biz    := NULLIF(v_intent->>'business_id', '')::uuid;

  SELECT op INTO v_op
    FROM jsonb_array_elements(v_intent->'operations') AS op
   WHERE op->>'operation' = _operation
   LIMIT 1;

  IF v_op IS NULL THEN
    RAISE EXCEPTION
      'Operation % is not available for % %. Available: %.',
      _operation, _document_type, v_number,
      COALESCE((SELECT string_agg(o->>'operation', ', ')
                  FROM jsonb_array_elements(v_intent->'operations') AS o), 'none')
      USING ERRCODE = '0A000';
  END IF;

  IF NOT COALESCE((v_op->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION '%',
      COALESCE(v_op->>'blocked_reason',
               'This ' || _document_type || ' cannot be reversed right now.')
      USING ERRCODE = '23514';
  END IF;

  -- The intent authority evaluates the period the document sits in; the writer
  -- may be posting the compensation into a different one.
  IF v_biz IS NOT NULL AND NOT public.is_period_open(v_biz, v_date) THEN
    RAISE EXCEPTION
      'The accounting period covering % is closed. Reverse % in an open period, or raise a credit note instead.',
      v_date, v_number
      USING ERRCODE = '23514';
  END IF;

  -- Phase 5.3 — high-value and prior-period reversals go through the
  -- organization's approval engine before any compensating entry is written.
  v_need := public.reversal_approval_requirement(
              _document_type, _document_id, _operation, v_date);

  IF NOT COALESCE((v_need->>'satisfied')::boolean, false) THEN
    RAISE EXCEPTION
      'Reversing % needs approval first: %',
      v_number,
      COALESCE((SELECT string_agg(r::text, ' ')
                  FROM jsonb_array_elements_text(v_need->'reasons') AS r),
               'an approval policy applies.')
      USING ERRCODE = '42501', HINT = 'REVERSAL_APPROVAL_REQUIRED';
  END IF;

  RETURN v_intent || jsonb_build_object('approval', v_need);
END;
$function$;