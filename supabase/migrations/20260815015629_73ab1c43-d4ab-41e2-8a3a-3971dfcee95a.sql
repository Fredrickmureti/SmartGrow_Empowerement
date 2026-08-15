CREATE TABLE IF NOT EXISTS public.sales_document_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  document_type text NOT NULL,
  idempotency_key text NOT NULL,
  document_id uuid,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_document_idempotency_unique UNIQUE (organization_id, document_type, idempotency_key)
);

GRANT SELECT ON public.sales_document_idempotency TO authenticated;
GRANT ALL ON public.sales_document_idempotency TO service_role;

ALTER TABLE public.sales_document_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sales_document_idempotency_select" ON public.sales_document_idempotency;
CREATE POLICY "sales_document_idempotency_select"
  ON public.sales_document_idempotency FOR SELECT TO authenticated
  USING (
    business_id IS NULL
      OR public.user_can_access_business(auth.uid(), business_id)
  );

DROP TRIGGER IF EXISTS trg_sales_document_idempotency_updated_at ON public.sales_document_idempotency;
CREATE TRIGGER trg_sales_document_idempotency_updated_at
  BEFORE UPDATE ON public.sales_document_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.create_invoice_atomic(
  p_header jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid := NULLIF(p_header->>'organization_id','')::uuid;
  v_business   uuid := NULLIF(p_header->>'business_id','')::uuid;
  v_branch     uuid := NULLIF(p_header->>'branch_id','')::uuid;
  v_user       uuid := COALESCE(p_user_id, auth.uid());
  v_currency   text;
  v_issue_date date := COALESCE(NULLIF(p_header->>'issue_date','')::date, CURRENT_DATE);
  v_due_date   date;
  v_number     text;
  v_invoice_id uuid;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, 0);
  v_total      numeric;
  v_rate       numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_ord        int := 0;
  v_display    numeric;
  v_res        jsonb;
  v_base       numeric;
  v_claimed    numeric;
  v_unit_price numeric;
  v_disc_pct   numeric;
  v_tax_rate   numeric;
  v_line_total numeric;
  v_tax_amount numeric;
  v_existing   jsonb;
  v_result     jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_business) THEN
    RAISE EXCEPTION 'Access denied for business %', v_business USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay: the same key never creates a second invoice.
  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT response INTO v_existing
      FROM public.sales_document_idempotency
     WHERE organization_id = v_org
       AND document_type = 'invoice'
       AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  v_due_date := COALESCE(NULLIF(p_header->>'due_date','')::date, v_issue_date);

  -- Quantity contract: the caller states what the CUSTOMER bought
  -- (display_quantity + display_uom_id | packaging_id). The canonical base
  -- quantity and the line money are derived here — never trusted.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    v_ord := v_ord + 1;
    v_display := COALESCE(
      NULLIF(v_item->>'display_quantity','')::numeric,
      NULLIF(v_item->>'quantity','')::numeric,
      1);
    IF v_display <= 0 THEN
      RAISE EXCEPTION 'line %: quantity must be greater than zero', v_ord USING ERRCODE = '22023';
    END IF;

    v_res := public.resolve_line_base_quantity(
      v_business,
      NULLIF(v_item->>'product_id','')::uuid,
      v_display,
      NULLIF(v_item->>'display_uom_id','')::uuid,
      NULLIF(v_item->>'packaging_id','')::uuid);
    v_base := (v_res->>'base_quantity')::numeric;

    v_claimed := NULLIF(v_item->>'quantity','')::numeric;
    IF v_claimed IS NOT NULL AND abs(v_claimed - v_base) > 0.0001 THEN
      RAISE EXCEPTION
        'line %: client base quantity % disagrees with the resolved base quantity % (display %)',
        v_ord, v_claimed, v_base, v_display USING ERRCODE = '22023';
    END IF;

    v_unit_price := COALESCE(NULLIF(v_item->>'unit_price','')::numeric, 0);
    v_disc_pct   := COALESCE(NULLIF(v_item->>'discount_percent','')::numeric, 0);
    v_tax_rate   := COALESCE(NULLIF(v_item->>'tax_rate','')::numeric, 0);
    -- Price is per CUSTOMER unit, so money follows the display quantity.
    v_line_total := round(v_display * v_unit_price * (1 - v_disc_pct / 100.0), 2);
    v_tax_amount := round(v_line_total * v_tax_rate / 100.0, 2);

    v_subtotal := v_subtotal + v_line_total;
    v_tax      := v_tax + v_tax_amount;

    v_lines := v_lines || jsonb_build_object(
      'product_id', NULLIF(v_item->>'product_id',''),
      'description', COALESCE(v_item->>'description',''),
      'quantity', v_base,
      'display_quantity', v_display,
      'display_uom_id', v_res->>'display_uom_id',
      'packaging_id', v_res->>'packaging_id',
      'uom_snapshot', v_res->>'uom_snapshot',
      'unit_price', v_unit_price,
      'discount_percent', v_disc_pct,
      'tax_rate', v_tax_rate,
      'tax_amount', v_tax_amount,
      'line_total', v_line_total,
      'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
      'project_id', NULLIF(v_item->>'project_id',''),
      'task_id', NULLIF(v_item->>'task_id',''),
      'lot_number', NULLIF(v_item->>'lot_number',''),
      'serial_number', NULLIF(v_item->>'serial_number','')
    );
  END LOOP;

  v_total := round(v_subtotal + v_tax - v_discount, 2);
  v_rate  := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_issue_date);
  v_number := public.get_next_invoice_number(v_org, v_business);

  INSERT INTO public.invoices (
    organization_id, business_id, branch_id, invoice_number, contact_id,
    issue_date, due_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, total,
    notes, terms, created_by, salesperson_id, payment_term_id,
    project_id, source_estimate_id, source_sales_order_id, source_proforma_invoice_id
  ) VALUES (
    v_org, v_business, v_branch, v_number,
    NULLIF(p_header->>'contact_id','')::uuid,
    v_issue_date, v_due_date,
    'draft', v_currency, v_rate,
    round(v_subtotal, 2), round(v_tax, 2), round(v_discount, 2), v_total,
    NULLIF(p_header->>'notes',''),
    NULLIF(p_header->>'terms',''),
    v_user,
    COALESCE(NULLIF(p_header->>'salesperson_id','')::uuid, v_user),
    NULLIF(p_header->>'payment_term_id','')::uuid,
    NULLIF(p_header->>'project_id','')::uuid,
    NULLIF(p_header->>'source_estimate_id','')::uuid,
    NULLIF(p_header->>'source_sales_order_id','')::uuid,
    NULLIF(p_header->>'source_proforma_invoice_id','')::uuid
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.invoice_items (
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, task_id, packaging_id, display_uom_id, display_quantity, uom_snapshot,
    lot_number, serial_number
  )
  SELECT
    v_invoice_id,
    NULLIF(i->>'product_id','')::uuid,
    i->>'description',
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric,
    (i->>'tax_rate')::numeric,
    (i->>'tax_amount')::numeric,
    (i->>'discount_percent')::numeric,
    (i->>'line_total')::numeric,
    (i->>'sort_order')::int,
    NULLIF(i->>'project_id','')::uuid,
    NULLIF(i->>'task_id','')::uuid,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    (i->>'display_quantity')::numeric,
    NULLIF(i->>'uom_snapshot',''),
    NULLIF(i->>'lot_number',''),
    NULLIF(i->>'serial_number','')
  FROM jsonb_array_elements(v_lines) AS t(i);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'discount_amount', round(v_discount, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_ord
  );

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    INSERT INTO public.sales_document_idempotency (
      organization_id, business_id, document_type, idempotency_key,
      document_id, response, created_by
    ) VALUES (
      v_org, v_business, 'invoice', p_idempotency_key,
      v_invoice_id, v_result, v_user
    )
    ON CONFLICT (organization_id, document_type, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_invoice_atomic(jsonb, jsonb, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invoice_atomic(jsonb, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_invoice_atomic(jsonb, jsonb, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';