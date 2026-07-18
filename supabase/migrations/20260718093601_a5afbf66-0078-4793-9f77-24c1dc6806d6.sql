
CREATE OR REPLACE FUNCTION public.get_next_requisition_number(_org_id uuid, _business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
  v_year text := to_char(CURRENT_DATE, 'YYYY');
BEGIN
  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(split_part(requisition_number,'-',3), '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1
  INTO v_next
  FROM public.purchase_requisitions
  WHERE organization_id = _org_id
    AND business_id = _business_id
    AND requisition_number LIKE 'PR-' || v_year || '-%';
  RETURN 'PR-' || v_year || '-' || LPAD(v_next::text, 4, '0');
END $$;

GRANT EXECUTE ON FUNCTION public.get_next_requisition_number(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_purchase_requisition(
  p_business_id uuid,
  p_need_by_date date DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_currency text DEFAULT 'USD',
  p_cost_center text DEFAULT NULL,
  p_justification text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_req_id uuid;
  v_req_no text;
  v_line jsonb;
  v_sort int := 0;
  v_total numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501';
  END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE='22023';
  END IF;

  v_req_no := public.get_next_requisition_number(v_org, p_business_id);

  INSERT INTO public.purchase_requisitions(
    organization_id, business_id, requisition_number, requester_id,
    cost_center, need_by_date, justification, notes,
    status, priority, currency, estimated_total
  ) VALUES (
    v_org, p_business_id, v_req_no, v_uid,
    p_cost_center, p_need_by_date, p_justification, p_notes,
    'draft', COALESCE(p_priority,'normal'), COALESCE(p_currency,'USD'), 0
  )
  RETURNING id INTO v_req_id;

  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) > 0 THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_sort := v_sort + 1;
      INSERT INTO public.purchase_requisition_items(
        requisition_id, product_id, description, uom_id, quantity,
        estimated_unit_price, need_by_date, suggested_supplier_id,
        contract_line_id, status, sort_order, notes
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
        'draft', v_sort, NULLIF(v_line->>'notes','')
      );
      v_total := v_total
        + COALESCE((v_line->>'quantity')::numeric, 0)
        * COALESCE((v_line->>'estimated_unit_price')::numeric, 0);
    END LOOP;
    UPDATE public.purchase_requisitions
       SET estimated_total = v_total, updated_at = now()
     WHERE id = v_req_id;
  END IF;

  RETURN v_req_id;
END $$;

GRANT EXECUTE ON FUNCTION public.create_purchase_requisition(uuid, date, text, text, text, text, text, jsonb) TO authenticated;

INSERT INTO public.governance_duties(duty_code, label, domain, description) VALUES
  ('bill.approve', 'Approve supplier bill', 'procurement', 'Approve a supplier bill for payment.'),
  ('requisition.approve', 'Approve requisition', 'procurement', 'Approve a purchase requisition.'),
  ('requisition.submit', 'Submit requisition', 'procurement', 'Submit a purchase requisition for approval.')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts(duty_a, duty_b, severity, rationale) VALUES
  ('requisition.approve', 'requisition.submit', 'critical',
   'Requester of a purchase requisition must not also approve it.'),
  ('po.create', 'requisition.approve', 'high',
   'Approver of a requisition should not also raise the resulting purchase order.'),
  ('po.create', 'po.receive', 'high',
   'Buyer that raised the PO should not also receipt goods against it.'),
  ('bill.approve', 'po.receive', 'high',
   'Receiver of goods should not also approve the matching supplier bill.')
ON CONFLICT (duty_a, duty_b) DO NOTHING;
