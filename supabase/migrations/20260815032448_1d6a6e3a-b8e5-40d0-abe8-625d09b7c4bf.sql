-- =====================================================================
-- Sales Domain Wave — Phase 9: governed writes + atomic estimate lifecycle
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. Atomic creator
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_estimate_atomic(
  p_header jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_costs jsonb DEFAULT '[]'::jsonb,
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
  v_expiry     date;
  v_number     text;
  v_estimate   uuid;
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
  v_cost       jsonb;
  v_cord       int := 0;
  v_cost_tax   numeric;
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

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    SELECT response INTO v_existing
      FROM public.sales_document_idempotency
     WHERE organization_id = v_org
       AND document_type = 'estimate'
       AND idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN v_existing || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(p_header->>'currency',''), b.base_currency, 'USD')
    INTO v_currency
    FROM public.businesses b WHERE b.id = v_business;

  v_expiry := COALESCE(NULLIF(p_header->>'expiry_date','')::date, v_issue_date + 30);

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
      'tax_rate_id', NULLIF(v_item->>'tax_rate_id',''),
      'tax_amount', v_tax_amount,
      'line_total', v_line_total,
      'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
      'scope_of_work', NULLIF(v_item->>'scope_of_work',''),
      'estimated_hours', NULLIF(v_item->>'estimated_hours',''),
      'hourly_rate', NULLIF(v_item->>'hourly_rate','')
    );
  END LOOP;

  FOR v_cost IN SELECT * FROM jsonb_array_elements(COALESCE(p_costs, '[]'::jsonb))
  LOOP
    v_cord := v_cord + 1;
    v_subtotal := v_subtotal + COALESCE(NULLIF(v_cost->>'amount','')::numeric, 0);
    IF COALESCE((v_cost->>'is_taxable')::boolean, false) THEN
      v_tax := v_tax + round(
        COALESCE(NULLIF(v_cost->>'amount','')::numeric, 0)
        * COALESCE(NULLIF(v_cost->>'tax_rate','')::numeric, 0) / 100.0, 2);
    END IF;
  END LOOP;

  v_total  := round(v_subtotal + v_tax - v_discount, 2);
  v_rate   := public.resolve_sales_exchange_rate(v_org, v_business, v_currency, v_issue_date);
  v_number := COALESCE(
    NULLIF(p_header->>'estimate_number',''),
    public.get_next_estimate_number(v_org, v_business, v_branch));

  INSERT INTO public.estimates (
    organization_id, business_id, branch_id, estimate_number, contact_id,
    issue_date, expiry_date, status, currency, exchange_rate,
    subtotal, tax_amount, discount_amount, total,
    notes, terms, created_by, source_lead_id, template_id,
    bill_to_contact_id, billing_address
  ) VALUES (
    v_org, v_business, v_branch, v_number,
    NULLIF(p_header->>'contact_id','')::uuid,
    v_issue_date, v_expiry,
    'draft', v_currency, v_rate,
    round(v_subtotal, 2), round(v_tax, 2), round(v_discount, 2), v_total,
    NULLIF(p_header->>'notes',''),
    NULLIF(p_header->>'terms',''),
    v_user,
    NULLIF(p_header->>'source_lead_id','')::uuid,
    NULLIF(p_header->>'template_id','')::uuid,
    NULLIF(p_header->>'bill_to_contact_id','')::uuid,
    CASE WHEN p_header ? 'billing_address' AND p_header->>'billing_address' IS NOT NULL
         THEN p_header->'billing_address' ELSE NULL END
  )
  RETURNING id INTO v_estimate;

  INSERT INTO public.estimate_items (
    estimate_id, product_id, description, quantity, unit_price,
    tax_rate, tax_rate_id, tax_amount, discount_percent, line_total, sort_order,
    packaging_id, display_uom_id, display_quantity, uom_snapshot,
    scope_of_work, estimated_hours, hourly_rate
  )
  SELECT
    v_estimate,
    NULLIF(i->>'product_id','')::uuid,
    i->>'description',
    (i->>'quantity')::numeric,
    (i->>'unit_price')::numeric,
    (i->>'tax_rate')::numeric,
    NULLIF(i->>'tax_rate_id','')::uuid,
    (i->>'tax_amount')::numeric,
    (i->>'discount_percent')::numeric,
    (i->>'line_total')::numeric,
    (i->>'sort_order')::int,
    NULLIF(i->>'packaging_id','')::uuid,
    NULLIF(i->>'display_uom_id','')::uuid,
    (i->>'display_quantity')::numeric,
    NULLIF(i->>'uom_snapshot',''),
    NULLIF(i->>'scope_of_work',''),
    NULLIF(i->>'estimated_hours','')::numeric,
    NULLIF(i->>'hourly_rate','')::numeric
  FROM jsonb_array_elements(v_lines) AS t(i);

  INSERT INTO public.estimate_additional_costs (
    estimate_id, name, amount, is_taxable, tax_rate, tax_amount, sort_order
  )
  SELECT
    v_estimate,
    COALESCE(c->>'name',''),
    COALESCE(NULLIF(c->>'amount','')::numeric, 0),
    COALESCE((c->>'is_taxable')::boolean, false),
    COALESCE(NULLIF(c->>'tax_rate','')::numeric, 0),
    CASE WHEN COALESCE((c->>'is_taxable')::boolean, false)
         THEN round(COALESCE(NULLIF(c->>'amount','')::numeric, 0)
                    * COALESCE(NULLIF(c->>'tax_rate','')::numeric, 0) / 100.0, 2)
         ELSE 0 END,
    COALESCE(NULLIF(c->>'sort_order','')::int, (ord - 1)::int)
  FROM jsonb_array_elements(COALESCE(p_costs, '[]'::jsonb)) WITH ORDINALITY AS t(c, ord);

  v_result := jsonb_build_object(
    'success', true,
    'estimate_id', v_estimate,
    'estimate_number', v_number,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'discount_amount', round(v_discount, 2),
    'total', v_total,
    'exchange_rate', v_rate,
    'item_count', v_ord,
    'cost_count', v_cord
  );

  IF p_idempotency_key IS NOT NULL AND btrim(p_idempotency_key) <> '' THEN
    INSERT INTO public.sales_document_idempotency (
      organization_id, business_id, document_type, idempotency_key,
      document_id, response, created_by
    ) VALUES (
      v_org, v_business, 'estimate', p_idempotency_key,
      v_estimate, v_result, v_user
    )
    ON CONFLICT (organization_id, document_type, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------
-- 2. Atomic updater (header + lines + costs in one transaction)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_estimate_atomic(
  p_estimate_id uuid,
  p_header jsonb DEFAULT '{}'::jsonb,
  p_items jsonb DEFAULT NULL::jsonb,
  p_costs jsonb DEFAULT NULL::jsonb,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user       uuid := COALESCE(p_user_id, auth.uid());
  v_est        public.estimates%ROWTYPE;
  v_subtotal   numeric := 0;
  v_tax        numeric := 0;
  v_discount   numeric;
  v_total      numeric;
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
  v_cost       jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent edits of the same estimate.
  SELECT * INTO v_est FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(v_user, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;
  IF v_est.status::text NOT IN ('draft','sent','viewed') THEN
    RAISE EXCEPTION
      'Estimate % is % — its lines are frozen. Duplicate it or issue a new estimate instead.',
      v_est.estimate_number, v_est.status USING ERRCODE = '42501';
  END IF;

  v_discount := COALESCE(NULLIF(p_header->>'discount_amount','')::numeric, v_est.discount_amount, 0);

  IF p_items IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
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
        v_est.business_id,
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
        'tax_rate_id', NULLIF(v_item->>'tax_rate_id',''),
        'tax_amount', v_tax_amount,
        'line_total', v_line_total,
        'sort_order', COALESCE(NULLIF(v_item->>'sort_order','')::int, v_ord - 1),
        'scope_of_work', NULLIF(v_item->>'scope_of_work',''),
        'estimated_hours', NULLIF(v_item->>'estimated_hours',''),
        'hourly_rate', NULLIF(v_item->>'hourly_rate','')
      );
    END LOOP;

    DELETE FROM public.estimate_items WHERE estimate_id = p_estimate_id;

    INSERT INTO public.estimate_items (
      estimate_id, product_id, description, quantity, unit_price,
      tax_rate, tax_rate_id, tax_amount, discount_percent, line_total, sort_order,
      packaging_id, display_uom_id, display_quantity, uom_snapshot,
      scope_of_work, estimated_hours, hourly_rate
    )
    SELECT
      p_estimate_id,
      NULLIF(i->>'product_id','')::uuid,
      i->>'description',
      (i->>'quantity')::numeric,
      (i->>'unit_price')::numeric,
      (i->>'tax_rate')::numeric,
      NULLIF(i->>'tax_rate_id','')::uuid,
      (i->>'tax_amount')::numeric,
      (i->>'discount_percent')::numeric,
      (i->>'line_total')::numeric,
      (i->>'sort_order')::int,
      NULLIF(i->>'packaging_id','')::uuid,
      NULLIF(i->>'display_uom_id','')::uuid,
      (i->>'display_quantity')::numeric,
      NULLIF(i->>'uom_snapshot',''),
      NULLIF(i->>'scope_of_work',''),
      NULLIF(i->>'estimated_hours','')::numeric,
      NULLIF(i->>'hourly_rate','')::numeric
    FROM jsonb_array_elements(v_lines) AS t(i);
  ELSE
    SELECT COALESCE(sum(line_total), 0), COALESCE(sum(tax_amount), 0)
      INTO v_subtotal, v_tax
      FROM public.estimate_items WHERE estimate_id = p_estimate_id;
  END IF;

  IF p_costs IS NOT NULL THEN
    DELETE FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id;
    INSERT INTO public.estimate_additional_costs (
      estimate_id, name, amount, is_taxable, tax_rate, tax_amount, sort_order
    )
    SELECT
      p_estimate_id,
      COALESCE(c->>'name',''),
      COALESCE(NULLIF(c->>'amount','')::numeric, 0),
      COALESCE((c->>'is_taxable')::boolean, false),
      COALESCE(NULLIF(c->>'tax_rate','')::numeric, 0),
      CASE WHEN COALESCE((c->>'is_taxable')::boolean, false)
           THEN round(COALESCE(NULLIF(c->>'amount','')::numeric, 0)
                      * COALESCE(NULLIF(c->>'tax_rate','')::numeric, 0) / 100.0, 2)
           ELSE 0 END,
      COALESCE(NULLIF(c->>'sort_order','')::int, (ord - 1)::int)
    FROM jsonb_array_elements(p_costs) WITH ORDINALITY AS t(c, ord);
  END IF;

  FOR v_cost IN
    SELECT jsonb_build_object('amount', amount, 'is_taxable', is_taxable, 'tax_rate', tax_rate)
      FROM public.estimate_additional_costs WHERE estimate_id = p_estimate_id
  LOOP
    v_subtotal := v_subtotal + COALESCE((v_cost->>'amount')::numeric, 0);
    IF COALESCE((v_cost->>'is_taxable')::boolean, false) THEN
      v_tax := v_tax + round(COALESCE((v_cost->>'amount')::numeric, 0)
                             * COALESCE((v_cost->>'tax_rate')::numeric, 0) / 100.0, 2);
    END IF;
  END LOOP;

  v_total := round(v_subtotal + v_tax - v_discount, 2);

  UPDATE public.estimates SET
    contact_id       = COALESCE(NULLIF(p_header->>'contact_id','')::uuid, contact_id),
    issue_date       = COALESCE(NULLIF(p_header->>'issue_date','')::date, issue_date),
    expiry_date      = COALESCE(NULLIF(p_header->>'expiry_date','')::date, expiry_date),
    notes            = COALESCE(NULLIF(p_header->>'notes',''), notes),
    terms            = COALESCE(NULLIF(p_header->>'terms',''), terms),
    template_id      = COALESCE(NULLIF(p_header->>'template_id','')::uuid, template_id),
    bill_to_contact_id = COALESCE(NULLIF(p_header->>'bill_to_contact_id','')::uuid, bill_to_contact_id),
    billing_address  = COALESCE(
      CASE WHEN p_header ? 'billing_address' THEN p_header->'billing_address' ELSE NULL END,
      billing_address),
    discount_amount  = round(v_discount, 2),
    subtotal         = round(v_subtotal, 2),
    tax_amount       = round(v_tax, 2),
    total            = v_total,
    updated_at       = now()
  WHERE id = p_estimate_id;

  RETURN jsonb_build_object(
    'success', true,
    'estimate_id', p_estimate_id,
    'estimate_number', v_est.estimate_number,
    'subtotal', round(v_subtotal, 2),
    'tax_amount', round(v_tax, 2),
    'discount_amount', round(v_discount, 2),
    'total', v_total
  );
END;
$function$;

-- ---------------------------------------------------------------
-- 3. Governed write: estimate header immutable fields
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._estimates_governed_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
  v_owned boolean;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;

  IF NEW.estimate_number IS DISTINCT FROM OLD.estimate_number THEN
    v_changed := array_append(v_changed, 'estimate_number');
  END IF;
  IF NEW.converted_invoice_id IS DISTINCT FROM OLD.converted_invoice_id THEN
    v_changed := array_append(v_changed, 'converted_invoice_id');
  END IF;
  IF NEW.converted_sales_order_id IS DISTINCT FROM OLD.converted_sales_order_id THEN
    v_changed := array_append(v_changed, 'converted_sales_order_id');
  END IF;
  IF NEW.converted_at IS DISTINCT FROM OLD.converted_at THEN
    v_changed := array_append(v_changed, 'converted_at');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;

  v_owned :=
       v_stack ILIKE '%create_estimate_atomic%'
    OR v_stack ILIKE '%update_estimate_atomic%'
    OR v_stack ILIKE '%set_estimate_status_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_so_atomic%'
    OR v_stack ILIKE '%convert_lead_to_estimate%'
    OR v_stack ILIKE '%reset_module__sales%'
    OR v_stack ILIKE '%_execute_organization_delete%';

  IF NOT v_owned THEN
    RAISE EXCEPTION
      'Estimate % — % may only be changed by the estimate engines (create_estimate_atomic, update_estimate_atomic, set_estimate_status_atomic, the conversion routes). Direct writes are rejected.',
      COALESCE(NEW.estimate_number, OLD.estimate_number), array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_estimates_governed_write ON public.estimates;
CREATE TRIGGER trg_00_estimates_governed_write
  BEFORE UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public._estimates_governed_write();

-- ---------------------------------------------------------------
-- 4. Governed write: estimate lines + additional costs
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._estimate_lines_governed_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
  v_owned boolean;
  v_estimate uuid := COALESCE(NEW.estimate_id, OLD.estimate_id);
  v_org uuid;
  v_status text;
  v_number text;
BEGIN
  SELECT e.organization_id, e.status::text, e.estimate_number
    INTO v_org, v_status, v_number
    FROM public.estimates e WHERE e.id = v_estimate;

  IF v_org IS NOT NULL AND public._is_teardown_for_org(v_org) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;

  v_owned :=
       v_stack ILIKE '%create_estimate_atomic%'
    OR v_stack ILIKE '%update_estimate_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_so_atomic%'
    OR v_stack ILIKE '%convert_lead_to_estimate%'
    OR v_stack ILIKE '%reset_module__sales%'
    OR v_stack ILIKE '%_execute_organization_delete%';

  IF NOT v_owned THEN
    RAISE EXCEPTION
      'Estimate % lines may only be written by create_estimate_atomic / update_estimate_atomic. Direct % on % is rejected.',
      COALESCE(v_number, v_estimate::text), TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  -- Immutability: an estimate that left the editable states is a frozen
  -- customer-facing document. Cancellation/replacement, never silent edits.
  IF v_status IS NOT NULL AND v_status NOT IN ('draft','sent','viewed')
     AND v_stack NOT ILIKE '%convert_estimate_to_%'
     AND v_stack NOT ILIKE '%reset_module__sales%'
     AND v_stack NOT ILIKE '%_execute_organization_delete%' THEN
    RAISE EXCEPTION
      'Estimate % is % — its lines are frozen.', COALESCE(v_number, v_estimate::text), v_status
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_estimate_items_governed_write ON public.estimate_items;
CREATE TRIGGER trg_00_estimate_items_governed_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.estimate_items
  FOR EACH ROW EXECUTE FUNCTION public._estimate_lines_governed_write();

DROP TRIGGER IF EXISTS trg_00_estimate_costs_governed_write ON public.estimate_additional_costs;
CREATE TRIGGER trg_00_estimate_costs_governed_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.estimate_additional_costs
  FOR EACH ROW EXECUTE FUNCTION public._estimate_lines_governed_write();

-- ---------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_estimate_atomic(jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_estimate_atomic(uuid, jsonb, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_estimate_atomic(jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_estimate_atomic(uuid, jsonb, jsonb, jsonb, uuid) TO authenticated, service_role;