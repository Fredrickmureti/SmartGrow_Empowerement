
-- 1) Outbox source allowlist
ALTER TABLE public.business_event_outbox DROP CONSTRAINT IF EXISTS business_event_outbox_source_check;
ALTER TABLE public.business_event_outbox
  ADD CONSTRAINT business_event_outbox_source_check
  CHECK (source = ANY (ARRAY['pos','finance','manual','system','trigger','procurement','purchasing','hr','crm','sales','inventory','warehouse','payroll']));

-- 2) Full unique constraint on idempotency_key
DROP INDEX IF EXISTS public.business_event_outbox_idempotency_key_uidx;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='business_event_outbox_idempotency_key_key' AND conrelid='public.business_event_outbox'::regclass) THEN
    ALTER TABLE public.business_event_outbox ADD CONSTRAINT business_event_outbox_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;

-- 3) Fix create_purchase_requisition line status ('draft' -> 'open')
CREATE OR REPLACE FUNCTION public.create_purchase_requisition(
  p_business_id uuid,
  p_need_by_date date DEFAULT NULL::date,
  p_priority text DEFAULT 'normal'::text,
  p_currency text DEFAULT 'USD'::text,
  p_cost_center text DEFAULT NULL::text,
  p_justification text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_req_id uuid;
  v_req_no text;
  v_line jsonb;
  v_sort int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Business not found' USING ERRCODE='22023'; END IF;

  v_req_no := public.get_next_requisition_number(v_org, p_business_id);
  INSERT INTO public.purchase_requisitions(
    organization_id, business_id, requisition_number, requester_id,
    cost_center, need_by_date, justification, notes,
    status, priority, currency, estimated_total
  ) VALUES (
    v_org, p_business_id, v_req_no, v_uid,
    p_cost_center, p_need_by_date, p_justification, p_notes,
    'draft', COALESCE(p_priority,'normal'), COALESCE(p_currency,'USD'), 0
  ) RETURNING id INTO v_req_id;

  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      v_sort := v_sort + 1;
      INSERT INTO public.purchase_requisition_items(
        requisition_id, product_id, description, uom_id, quantity,
        estimated_unit_price,
        need_by_date, suggested_supplier_id, contract_line_id,
        status, sort_order, notes
      ) VALUES (
        v_req_id,
        NULLIF(v_line->>'product_id','')::uuid,
        COALESCE(v_line->>'description',''),
        NULLIF(v_line->>'uom_id','')::uuid,
        COALESCE((v_line->>'quantity')::numeric, 0),
        COALESCE((v_line->>'estimated_unit_price')::numeric, 0),
        NULLIF(v_line->>'need_by_date','')::date,
        NULLIF(v_line->>'suggested_supplier_id','')::uuid,
        NULLIF(v_line->>'contract_line_id','')::uuid,
        'open', v_sort, NULLIF(v_line->>'notes','')
      );
    END LOOP;
  END IF;
  RETURN v_req_id;
END $function$;

-- 4) Governance seeds
INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('contract.create',   'Create procurement contract',  'procurement', 'Author a supplier contract in draft state'),
  ('contract.approve',  'Approve procurement contract', 'procurement', 'Activate a draft supplier contract'),
  ('sourcing.create',   'Create sourcing event',        'procurement', 'Open an RFI/RFQ/RFP/auction sourcing event'),
  ('sourcing.award',    'Award sourcing event',         'procurement', 'Award a sourcing event to a supplier'),
  ('goods_receipt.post','Post goods receipt',           'purchasing',  'Post a goods receipt against a purchase order'),
  ('bill.match',        'Match supplier bill',          'procurement', 'Match a supplier bill against PO + goods receipt'),
  ('bill.pay',          'Pay supplier bill',            'procurement', 'Release a payment against an approved supplier bill')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('contract.approve',  'contract.create',   'high',   'Contract approver must be independent of the drafter'),
  ('sourcing.award',    'sourcing.create',   'high',   'Sourcing award authority must be independent of event creation'),
  ('goods_receipt.post','po.approve',        'medium', 'PO approver should not also acknowledge physical receipt'),
  ('bill.approve',      'bill.match',        'high',   'Matcher should not also approve the bill'),
  ('bill.approve',      'bill.pay',          'high',   'Payer should not also approve the bill'),
  ('bill.match',        'bill.pay',          'medium', 'Payer should not also perform the 3-way match')
ON CONFLICT DO NOTHING;

-- 5) Runtime smoke
DO $smoke$
DECLARE
  v_org      uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz      uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_user_a   uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_user_b   uuid := '351895bd-78d1-49e9-8757-5ca681562940';
  v_contact  uuid;
  v_supplier uuid;
  v_qual jsonb; v_qid uuid;
  v_contract jsonb; v_cid uuid;
  v_req uuid; v_result jsonb;
  v_run_tag  text := 'smoke-' || substr(md5(random()::text), 1, 8);
  v_outbox int;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);

    INSERT INTO public.contacts (organization_id, business_id, name, type, supplier_rank)
    VALUES (v_org, v_biz, v_run_tag || ' Supplier Co', 'supplier', 1)
    RETURNING id INTO v_contact;

    INSERT INTO public.suppliers (organization_id, business_id, contact_id, supplier_code, lifecycle_state, created_by)
    VALUES (v_org, v_biz, v_contact, v_run_tag || '-supp', 'draft', v_user_a)
    RETURNING id INTO v_supplier;

    -- P1
    v_qual := public.submit_supplier_qualification(v_supplier, jsonb_build_object('smoke', v_run_tag));
    IF v_qual->>'success' <> 'true' THEN RAISE EXCEPTION 'submit_qual failed: %', v_qual; END IF;
    v_qid := (v_qual->>'qualification_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='supplier.qualification_submitted' AND source_doc_id=v_qid)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing supplier.qualification_submitted'; END IF;

    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    v_qual := public.approve_supplier_qualification(v_qid, 92::numeric, (now() + interval '1 year'), 'smoke');
    IF v_qual->>'success' <> 'true' THEN RAISE EXCEPTION 'approve_qual failed: %', v_qual; END IF;

    v_qual := public.suspend_supplier(v_supplier, 'smoke suspend');
    IF v_qual->>'success' <> 'true' THEN RAISE EXCEPTION 'suspend failed: %', v_qual; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='supplier.suspended' AND source_doc_id=v_supplier)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing supplier.suspended'; END IF;

    v_qual := public.reinstate_supplier(v_supplier, 'smoke reinstate');
    IF v_qual->>'success' <> 'true' THEN RAISE EXCEPTION 'reinstate failed: %', v_qual; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='supplier.reinstated' AND source_doc_id=v_supplier)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing supplier.reinstated'; END IF;

    -- P2
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    v_contract := public.create_procurement_contract(
      v_biz, v_supplier, ('CT-' || v_run_tag)::text, 'Smoke Contract'::text, 'rate'::text, 'USD'::text,
      current_date::date, (current_date + interval '1 year')::date, 100000::numeric, '[]'::jsonb, 'smoke'::text
    );
    IF v_contract->>'success' <> 'true' THEN RAISE EXCEPTION 'create_contract failed: %', v_contract; END IF;
    v_cid := (v_contract->>'contract_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='procurement.contract.created' AND source_doc_id=v_cid)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.contract.created'; END IF;

    v_contract := public.activate_procurement_contract(v_cid);
    IF v_contract->>'success' <> 'false' OR v_contract->>'error' <> 'Approver cannot equal creator'
    THEN RAISE EXCEPTION 'SMOKE FAIL: self-activation not blocked: %', v_contract; END IF;

    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    v_contract := public.activate_procurement_contract(v_cid);
    IF v_contract->>'success' <> 'true' THEN RAISE EXCEPTION 'activate_contract failed: %', v_contract; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='procurement.contract.activated' AND source_doc_id=v_cid)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.contract.activated'; END IF;

    v_contract := public.terminate_procurement_contract(v_cid, 'smoke end');
    IF v_contract->>'success' <> 'true' THEN RAISE EXCEPTION 'terminate_contract failed: %', v_contract; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='procurement.contract.terminated' AND source_doc_id=v_cid)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.contract.terminated'; END IF;

    -- P3
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    v_req := public.create_purchase_requisition(
      v_biz, (current_date + interval '30 days')::date,
      'normal', 'USD', 'CC-SMOKE', 'smoke justification', 'smoke notes',
      jsonb_build_array(
        jsonb_build_object('description','Smoke item A','quantity',5,'estimated_unit_price',10.00),
        jsonb_build_object('description','Smoke item B','quantity',2,'estimated_unit_price',25.00)
      )
    );
    IF v_req IS NULL THEN RAISE EXCEPTION 'create_requisition returned null'; END IF;
    IF (SELECT COALESCE(sum(estimated_line_total),0) FROM public.purchase_requisition_items WHERE requisition_id=v_req) <> 100.00
    THEN RAISE EXCEPTION 'SMOKE FAIL: estimated_line_total not computed correctly'; END IF;

    v_result := public.submit_requisition(v_req);
    IF v_result->>'success' <> 'true' THEN RAISE EXCEPTION 'submit_requisition failed: %', v_result; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='procurement.requisition.submitted' AND source_doc_id=v_req)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.requisition.submitted'; END IF;

    v_result := public.approve_requisition(v_req, 'self');
    IF v_result->>'success' <> 'false' OR v_result->>'error' <> 'Approver cannot equal requester'
    THEN RAISE EXCEPTION 'SMOKE FAIL: self-approval not blocked: %', v_result; END IF;

    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    v_result := public.approve_requisition(v_req, 'smoke ok');
    IF v_result->>'success' <> 'true' THEN RAISE EXCEPTION 'approve_requisition failed: %', v_result; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.business_event_outbox WHERE event_type='procurement.requisition.approved' AND source_doc_id=v_req)
    THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.requisition.approved'; END IF;

    SELECT count(*) INTO v_outbox
    FROM public.business_event_outbox
    WHERE (event_type LIKE 'supplier.%' OR event_type LIKE 'procurement.%')
      AND source_doc_id IN (v_supplier, v_qid, v_cid, v_req);
    IF v_outbox < 8 THEN RAISE EXCEPTION 'SMOKE FAIL: expected >=8 outbox rows, got %', v_outbox; END IF;

    RAISE NOTICE 'Procurement Batch C-Verify: emitted % outbox events across P1/P2/P3', v_outbox;
    RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> '__SMOKE_ROLLBACK_MARKER__' THEN RAISE; END IF;
      RAISE NOTICE 'Procurement Batch C-Verify PASSED (smoke rolled back cleanly)';
  END;
END
$smoke$;
