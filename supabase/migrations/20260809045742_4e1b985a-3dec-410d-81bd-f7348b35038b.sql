-- ============================================================
-- Returns convergence Phase 3 (server-owned creation, numbering,
-- idempotency), Phase 4 (lifecycle) and Phase 5 (line security)
-- ============================================================

-- ---------- Phase 3.1: numbering ----------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS sales_return_prefix text;

CREATE OR REPLACE FUNCTION public.get_next_sales_return_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num integer;
  prefix text;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for sales return numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sales_returns_' || _business_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN return_number ~ '\d+$'
      THEN CAST(substring(return_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.sales_returns
  WHERE organization_id = _org_id
    AND business_id = _business_id;

  SELECT COALESCE(NULLIF(b.sales_return_prefix, ''), 'SR-')
    INTO prefix
  FROM public.businesses b
  WHERE b.id = _business_id;

  RETURN COALESCE(prefix, 'SR-') || LPAD(next_num::text, 5, '0');
END;
$function$;

-- Single allocation point: any writer (RPC, WMS finance doc, backfill) that
-- does not supply a canonical number gets one from the series above.
CREATE OR REPLACE FUNCTION public.assign_sales_return_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text;
BEGIN
  SELECT COALESCE(NULLIF(b.sales_return_prefix, ''), 'SR-') INTO v_prefix
    FROM public.businesses b WHERE b.id = NEW.business_id;
  v_prefix := COALESCE(v_prefix, 'SR-');

  IF NEW.return_number IS NULL
     OR NEW.return_number = ''
     OR NEW.return_number !~ ('^' || regexp_replace(v_prefix, '([\.\^\$\*\+\?\(\)\[\]\{\}\|\\])', '\\\1', 'g') || '\d+$')
  THEN
    NEW.return_number := public.get_next_sales_return_number(
      NEW.organization_id, NEW.business_id, NEW.branch_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assign_sales_return_number ON public.sales_returns;
CREATE TRIGGER trg_assign_sales_return_number
BEFORE INSERT ON public.sales_returns
FOR EACH ROW EXECUTE FUNCTION public.assign_sales_return_number();

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_org_number
  ON public.sales_returns(organization_id, return_number);

-- ---------- Phase 3.2: idempotent, server-owned creation ----------
ALTER TABLE public.sales_returns
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_returns_client_request
  ON public.sales_returns(organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_sales_return_atomic(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := (_payload->>'organization_id')::uuid;
  v_business uuid := (_payload->>'business_id')::uuid;
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_crid text := NULLIF(_payload->>'client_request_id','');
  v_items jsonb := COALESCE(_payload->'items', '[]'::jsonb);
  v_existing public.sales_returns%ROWTYPE;
  v_id uuid;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
  v_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_business IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'a sales return needs at least one line' USING ERRCODE = '22023';
  END IF;

  -- Replay safety: the same request returns the same document.
  IF v_crid IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.sales_returns
     WHERE organization_id = v_org AND client_request_id = v_crid;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'id', v_existing.id,
        'return_number', v_existing.return_number, 'created', false);
    END IF;
  END IF;

  -- Totals are derived server-side, never trusted from the browser.
  SELECT
    COALESCE(SUM(ROUND((it->>'quantity')::numeric * (it->>'unit_price')::numeric, 6)), 0),
    COALESCE(SUM(COALESCE(NULLIF(it->>'tax_amount','')::numeric, 0)), 0)
  INTO v_subtotal, v_tax
  FROM jsonb_array_elements(v_items) it;
  v_total := v_subtotal + v_tax;

  INSERT INTO public.sales_returns(
    organization_id, business_id, branch_id, contact_id, return_number, return_date,
    status, invoice_id, reason, currency, subtotal, tax_amount, total,
    refund_method, notes, created_by, client_request_id
  ) VALUES (
    v_org, v_business, v_branch,
    NULLIF(_payload->>'contact_id','')::uuid,
    NULL,
    COALESCE(NULLIF(_payload->>'return_date','')::date, CURRENT_DATE),
    'pending',
    NULLIF(_payload->>'invoice_id','')::uuid,
    COALESCE(NULLIF(_payload->>'reason',''), 'Customer return'),
    COALESCE(NULLIF(_payload->>'currency',''),
             (SELECT base_currency FROM public.businesses WHERE id = v_business)),
    v_subtotal, v_tax, v_total,
    NULLIF(_payload->>'refund_method',''),
    NULLIF(_payload->>'notes',''),
    auth.uid(), v_crid
  ) RETURNING id, return_number INTO v_id, v_number;

  INSERT INTO public.sales_return_items(
    sales_return_id, product_id, invoice_item_id, description, quantity, unit_price,
    tax_rate, tax_amount, line_total, return_reason, condition,
    lot_number, serial_number, sort_order
  )
  SELECT
    v_id,
    NULLIF(it->>'product_id','')::uuid,
    NULLIF(it->>'invoice_item_id','')::uuid,
    COALESCE(NULLIF(it->>'description',''), 'Returned item'),
    (it->>'quantity')::numeric,
    (it->>'unit_price')::numeric,
    COALESCE(NULLIF(it->>'tax_rate','')::numeric, 0),
    COALESCE(NULLIF(it->>'tax_amount','')::numeric, 0),
    ROUND((it->>'quantity')::numeric * (it->>'unit_price')::numeric, 6),
    NULLIF(it->>'return_reason',''),
    COALESCE(NULLIF(it->>'condition',''), 'good'),
    NULLIF(it->>'lot_number',''),
    NULLIF(it->>'serial_number',''),
    (ord - 1)::integer
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(it, ord);

  RETURN jsonb_build_object('success', true, 'id', v_id,
    'return_number', v_number, 'created', true,
    'subtotal', v_subtotal, 'tax_amount', v_tax, 'total', v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_sales_return_atomic(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.create_sales_return_atomic(jsonb) TO authenticated;

-- ---------- Phase 4: the lifecycle is enforced in one place ----------
CREATE OR REPLACE FUNCTION public.transition_sales_return(
  _return_id uuid,
  _to_status text,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sr public.sales_returns%ROWTYPE;
  v_allowed text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sr FROM public.sales_returns WHERE id = _return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales return % not found', _return_id USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_sr.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_sr.business_id USING ERRCODE = '42501';
  END IF;

  IF v_sr.status = _to_status THEN
    RETURN jsonb_build_object('success', true, 'status', v_sr.status, 'changed', false);
  END IF;

  v_allowed := CASE v_sr.status
    WHEN 'pending'  THEN ARRAY['rejected']          -- 'approved' belongs to approve_sales_return_atomic
    WHEN 'approved' THEN ARRAY['received']
    WHEN 'received' THEN ARRAY['refunded']
    ELSE ARRAY[]::text[]
  END;

  IF _to_status = 'approved' THEN
    RAISE EXCEPTION 'approve a sales return through approve_sales_return_atomic, not a bare status change'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (_to_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'sales return cannot move from % to %', v_sr.status, _to_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.sales_returns
     SET status = _to_status,
         notes = CASE WHEN _reason IS NULL OR _reason = '' THEN notes
                      ELSE COALESCE(notes || E'\n', '') || _to_status || ': ' || _reason END,
         updated_at = now()
   WHERE id = _return_id;

  RETURN jsonb_build_object('success', true, 'status', _to_status, 'changed', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_sales_return(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.transition_sales_return(uuid, text, text) TO authenticated;

-- ---------- Phase 5: line-level security parity with credit_note_items ----------
DROP POLICY IF EXISTS "Users can manage sales return items" ON public.sales_return_items;

CREATE POLICY sales_return_items_select_v2 ON public.sales_return_items
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales_returns sr
   WHERE sr.id = sales_return_items.sales_return_id
     AND public.user_can_access_business(auth.uid(), sr.business_id)
     AND public.user_has_module_permission(auth.uid(), sr.organization_id, sr.business_id, 'sales', 'read')
     AND (sr.branch_id IS NULL OR public.user_can_access_branch(auth.uid(), sr.branch_id)
          OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', sr.business_id))
));

CREATE POLICY sales_return_items_insert_v2 ON public.sales_return_items
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.sales_returns sr
   WHERE sr.id = sales_return_items.sales_return_id
     AND public.user_can_access_business(auth.uid(), sr.business_id)
     AND public.user_has_module_permission(auth.uid(), sr.organization_id, sr.business_id, 'sales', 'create')
));

CREATE POLICY sales_return_items_update_v2 ON public.sales_return_items
FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales_returns sr
   WHERE sr.id = sales_return_items.sales_return_id
     AND public.user_can_access_business(auth.uid(), sr.business_id)
     AND public.user_has_module_permission(auth.uid(), sr.organization_id, sr.business_id, 'sales', 'write')
     AND (sr.branch_id IS NULL OR public.user_can_access_branch(auth.uid(), sr.branch_id))
));

CREATE POLICY sales_return_items_delete_v2 ON public.sales_return_items
FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales_returns sr
   WHERE sr.id = sales_return_items.sales_return_id
     AND public.user_can_access_business(auth.uid(), sr.business_id)
     AND public.user_has_module_permission(auth.uid(), sr.organization_id, sr.business_id, 'sales', 'delete')
     AND (sr.branch_id IS NULL OR public.user_can_access_branch(auth.uid(), sr.branch_id))
));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_return_items TO authenticated;
GRANT ALL ON public.sales_return_items TO service_role;