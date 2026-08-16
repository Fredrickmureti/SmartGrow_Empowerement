-- =========================================================================
-- Supplier purchasing conditions — Phases 1-5 of the reconstruction plan.
-- Extends ADR 0141. No new FX / UoM / approval / event engines are created.
-- =========================================================================

-- ---------------------------------------------------------------- Phase 3/4 schema
ALTER TABLE public.supplier_item_terms
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approval_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'supplier_item_terms_approval_status_chk'
  ) THEN
    ALTER TABLE public.supplier_item_terms
      ADD CONSTRAINT supplier_item_terms_approval_status_chk
      CHECK (approval_status IN ('draft','pending_approval','approved','rejected'));
  END IF;
END $$;

COMMENT ON COLUMN public.supplier_item_terms.lead_time_days IS
  'Calendar days from purchase-order issue until the goods are available at the receiving location.';
COMMENT ON COLUMN public.supplier_item_terms.price_break_tiers IS
  'Ordered [{min_qty, unit_price}] tiers, strictly increasing by min_qty. min_qty is expressed in the same unit as min_order_qty (the purchase UoM), so price and quantity policy always share one basis.';
COMMENT ON COLUMN public.supplier_item_terms.branch_id IS
  'NULL = company-wide condition. A branch-specific row overrides the company-wide row for that branch.';

-- Branch-aware overlap guard: two branches may hold different conditions for
-- the same product/supplier/window; only rows in the same branch scope collide.
CREATE OR REPLACE FUNCTION public._validate_supplier_item_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tier JSONB; v_prev_qty NUMERIC := -1; v_qty NUMERIC; v_price NUMERIC;
BEGIN
  IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
    RAISE EXCEPTION 'supplier_item_terms: effective_to (%) must be greater than effective_from (%)', NEW.effective_to, NEW.effective_from;
  END IF;
  IF NEW.preferred_rank < 0 THEN RAISE EXCEPTION 'supplier_item_terms: preferred_rank must be non-negative'; END IF;
  IF NEW.lead_time_days < 0 THEN RAISE EXCEPTION 'supplier_item_terms: lead_time_days must be non-negative'; END IF;
  IF NEW.min_order_qty < 0 THEN RAISE EXCEPTION 'supplier_item_terms: min_order_qty must be non-negative'; END IF;
  IF jsonb_typeof(NEW.price_break_tiers) <> 'array' THEN
    RAISE EXCEPTION 'supplier_item_terms: price_break_tiers must be a JSON array';
  END IF;
  FOR v_tier IN SELECT * FROM jsonb_array_elements(NEW.price_break_tiers) LOOP
    v_qty := (v_tier->>'min_qty')::NUMERIC;
    v_price := (v_tier->>'unit_price')::NUMERIC;
    IF v_qty IS NULL OR v_price IS NULL THEN
      RAISE EXCEPTION 'supplier_item_terms: each tier must have min_qty and unit_price';
    END IF;
    IF v_qty < 0 OR v_price < 0 THEN
      RAISE EXCEPTION 'supplier_item_terms: tier min_qty and unit_price must be non-negative';
    END IF;
    IF v_qty <= v_prev_qty THEN
      RAISE EXCEPTION 'supplier_item_terms: price_break_tiers must be strictly increasing by min_qty (got % after %)', v_qty, v_prev_qty;
    END IF;
    v_prev_qty := v_qty;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.supplier_item_terms t
    WHERE t.business_id = NEW.business_id
      AND t.product_id  = NEW.product_id
      AND t.supplier_id = NEW.supplier_id
      AND t.branch_id IS NOT DISTINCT FROM NEW.branch_id
      AND t.is_active
      AND t.approval_status <> 'rejected'
      AND t.id <> NEW.id
      AND daterange(t.effective_from, COALESCE(t.effective_to, 'infinity'::date), '[)')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION 'supplier_item_terms: effective window overlaps an existing row for this product/supplier in the same branch scope';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Phase 1
-- The terms resolver becomes price-complete: it now takes the quantity and
-- applies the stored price-break tiers. Browser code never picks a tier.
DROP FUNCTION IF EXISTS public.resolve_supplier_purchasing_terms(uuid, uuid, uuid, date);

CREATE OR REPLACE FUNCTION public.resolve_supplier_purchasing_terms(
  p_business_id uuid,
  p_product_id  uuid,
  p_supplier_id uuid DEFAULT NULL,
  p_on_date     date DEFAULT CURRENT_DATE,
  p_quantity    numeric DEFAULT NULL,
  p_branch_id   uuid DEFAULT NULL
)
RETURNS TABLE(
  product_id uuid, supplier_id uuid, terms_id uuid,
  min_order_qty numeric, min_order_source text,
  order_increment numeric, increment_source text,
  lead_time_days integer, lead_time_source text,
  currency_code text, purchase_uom_id uuid, unit_price numeric,
  effective_from date, effective_to date,
  price_source text, tier_min_qty numeric, branch_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t public.supplier_item_terms;
  v_p RECORD;
  v_supplier uuid;
  v_qty numeric;
  v_tier_price numeric;
  v_tier_qty numeric;
  v_price_source text;
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'SUPPLIER_TERMS_FORBIDDEN: no access to business %', p_business_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.id, p.business_id, p.min_order_quantity, p.order_quantity_increment,
         p.purchase_uom_id, p.base_uom_id
    INTO v_p
  FROM public.products p
  WHERE p.id = p_product_id AND p.business_id = p_business_id;

  IF v_p.id IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_TERMS_PRODUCT_NOT_FOUND: product % is not in business %',
      p_product_id, p_business_id;
  END IF;

  v_supplier := CASE
    WHEN p_supplier_id IS NULL THEN NULL
    ELSE public._resolve_supplier_role_id(p_business_id, p_supplier_id)
  END;

  -- Branch-specific conditions win over the company-wide (NULL branch) row.
  SELECT t.* INTO v_t
  FROM public.supplier_item_terms t
  WHERE t.business_id = p_business_id
    AND t.product_id  = p_product_id
    AND (v_supplier IS NULL OR t.supplier_id = v_supplier)
    AND t.is_active
    AND t.approval_status = 'approved'
    AND (t.branch_id IS NULL OR p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND t.effective_from <= COALESCE(p_on_date, CURRENT_DATE)
    AND (t.effective_to IS NULL OR t.effective_to >= COALESCE(p_on_date, CURRENT_DATE))
  ORDER BY (t.branch_id IS NULL), t.preferred_rank, t.effective_from DESC
  LIMIT 1;

  v_qty := COALESCE(p_quantity, v_t.min_order_qty, v_p.min_order_quantity, 1);

  -- Applicable tier: the highest min_qty at or below the ordered quantity.
  IF v_t.id IS NOT NULL THEN
    SELECT (e->>'unit_price')::numeric, (e->>'min_qty')::numeric
      INTO v_tier_price, v_tier_qty
      FROM jsonb_array_elements(COALESCE(v_t.price_break_tiers, '[]'::jsonb)) e
     WHERE (e->>'min_qty')::numeric <= v_qty
     ORDER BY (e->>'min_qty')::numeric DESC
     LIMIT 1;
  END IF;

  v_price_source := CASE
    WHEN v_tier_price IS NOT NULL THEN 'tier'
    WHEN v_t.unit_price IS NOT NULL THEN 'flat'
    ELSE 'none'
  END;

  RETURN QUERY SELECT
    p_product_id,
    v_t.supplier_id,
    v_t.id,
    COALESCE(v_t.min_order_qty, v_p.min_order_quantity, 1)::numeric,
    CASE WHEN v_t.min_order_qty IS NOT NULL THEN 'supplier'
         WHEN v_p.min_order_quantity IS NOT NULL THEN 'product_default'
         ELSE 'system_default' END,
    COALESCE(v_t.order_increment, v_p.order_quantity_increment, 1)::numeric,
    CASE WHEN v_t.order_increment IS NOT NULL THEN 'supplier'
         WHEN v_p.order_quantity_increment IS NOT NULL THEN 'product_default'
         ELSE 'system_default' END,
    v_t.lead_time_days,
    CASE WHEN v_t.lead_time_days IS NOT NULL THEN 'supplier' ELSE 'system_default' END,
    v_t.currency_code,
    COALESCE(v_t.purchase_uom_id, v_p.purchase_uom_id, v_p.base_uom_id),
    COALESCE(v_tier_price, v_t.unit_price),
    v_t.effective_from,
    v_t.effective_to,
    v_price_source,
    v_tier_qty,
    v_t.branch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_supplier_purchasing_terms(uuid,uuid,uuid,date,numeric,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_supplier_purchasing_terms(uuid,uuid,uuid,date,numeric,uuid) TO authenticated, service_role;

-- Quantity policy keeps calling the resolver, now by name so the new
-- parameters cannot be bound positionally by accident.
CREATE OR REPLACE FUNCTION public.validate_supplier_order_quantity(
  p_business_id uuid, p_product_id uuid, p_supplier_id uuid,
  p_quantity numeric, p_on_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(is_valid boolean, reason text, min_order_qty numeric,
              order_increment numeric, adjusted_quantity numeric,
              min_order_source text, increment_source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
  v_adjusted numeric;
  v_steps numeric;
BEGIN
  SELECT * INTO v FROM public.resolve_supplier_purchasing_terms(
    p_business_id => p_business_id,
    p_product_id  => p_product_id,
    p_supplier_id => p_supplier_id,
    p_on_date     => COALESCE(p_on_date, CURRENT_DATE),
    p_quantity    => p_quantity);

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN QUERY SELECT false, 'QUANTITY_NOT_POSITIVE', v.min_order_qty, v.order_increment,
                        v.min_order_qty, v.min_order_source, v.increment_source;
    RETURN;
  END IF;

  IF p_quantity < v.min_order_qty THEN
    RETURN QUERY SELECT false, 'BELOW_MIN_ORDER_QTY', v.min_order_qty, v.order_increment,
                        v.min_order_qty, v.min_order_source, v.increment_source;
    RETURN;
  END IF;

  IF v.order_increment IS NOT NULL AND v.order_increment > 0 THEN
    v_steps := (p_quantity - v.min_order_qty) / v.order_increment;
    IF abs(v_steps - round(v_steps)) > 1e-9 THEN
      v_adjusted := v.min_order_qty + ceil(v_steps) * v.order_increment;
      RETURN QUERY SELECT false, 'NOT_ON_ORDER_INCREMENT', v.min_order_qty, v.order_increment,
                          v_adjusted, v.min_order_source, v.increment_source;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, NULL::text, v.min_order_qty, v.order_increment,
                      p_quantity, v.min_order_source, v.increment_source;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_supplier_order_quantity(uuid,uuid,uuid,numeric,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_supplier_order_quantity(uuid,uuid,uuid,numeric,date) TO authenticated, service_role;

-- ---------------------------------------------------------------- Phase 2
-- ONE purchasing price authority. Precedence, decided server-side:
--   active contract line -> supplier tier -> supplier flat -> product default -> manual
CREATE OR REPLACE FUNCTION public._resolve_purchase_line_price(
  p_business_id uuid, p_product_id uuid, p_supplier_id uuid,
  p_quantity numeric DEFAULT NULL, p_on_date date DEFAULT CURRENT_DATE,
  p_branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier uuid;
  v_c RECORD;
  v_t RECORD;
  v_date date := COALESCE(p_on_date, CURRENT_DATE);
  v_product_default numeric;
BEGIN
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('price_source','manual');
  END IF;

  v_supplier := CASE WHEN p_supplier_id IS NULL THEN NULL
                     ELSE public._resolve_supplier_role_id(p_business_id, p_supplier_id) END;

  -- 1. An active contract line is a commitment and outranks standing terms.
  IF v_supplier IS NOT NULL THEN
    SELECT cl.id AS line_id, cl.contract_id, cl.unit_price, cl.uom_id, c.currency
      INTO v_c
      FROM public.procurement_contract_lines cl
      JOIN public.procurement_contracts c ON c.id = cl.contract_id
     WHERE c.business_id = p_business_id
       AND c.supplier_id = v_supplier
       AND c.status = 'active'
       AND cl.product_id = p_product_id
       AND cl.unit_price IS NOT NULL
       AND (c.start_date IS NULL OR c.start_date <= v_date)
       AND (c.end_date IS NULL OR c.end_date >= v_date)
       AND (cl.effective_from IS NULL OR cl.effective_from <= v_date)
       AND (cl.effective_to IS NULL OR cl.effective_to >= v_date)
       AND (cl.min_quantity IS NULL OR cl.min_quantity <= COALESCE(p_quantity, cl.min_quantity))
     ORDER BY COALESCE(cl.min_quantity, 0) DESC
     LIMIT 1;

    IF v_c.line_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'unit_price', v_c.unit_price,
        'currency_code', v_c.currency,
        'purchase_uom_id', v_c.uom_id,
        'price_source', 'contract',
        'contract_id', v_c.contract_id,
        'contract_line_id', v_c.line_id);
    END IF;
  END IF;

  -- 2/3. Standing supplier condition (tier, then flat).
  SELECT * INTO v_t FROM public.resolve_supplier_purchasing_terms(
    p_business_id => p_business_id,
    p_product_id  => p_product_id,
    p_supplier_id => p_supplier_id,
    p_on_date     => v_date,
    p_quantity    => p_quantity,
    p_branch_id   => p_branch_id);

  IF v_t.unit_price IS NOT NULL THEN
    RETURN jsonb_build_object(
      'unit_price', v_t.unit_price,
      'currency_code', v_t.currency_code,
      'purchase_uom_id', v_t.purchase_uom_id,
      'price_source', CASE WHEN v_t.price_source = 'tier' THEN 'supplier_tier' ELSE 'supplier_flat' END,
      'supplier_terms_id', v_t.terms_id,
      'tier_min_qty', v_t.tier_min_qty,
      'lead_time_days', v_t.lead_time_days);
  END IF;

  -- 4. Product default.
  SELECT p.cost_price INTO v_product_default
    FROM public.products p WHERE p.id = p_product_id AND p.business_id = p_business_id;

  IF v_product_default IS NOT NULL AND v_product_default > 0 THEN
    RETURN jsonb_build_object(
      'unit_price', v_product_default,
      'purchase_uom_id', v_t.purchase_uom_id,
      'price_source', 'product_default');
  END IF;

  RETURN jsonb_build_object('price_source', 'manual',
                            'purchase_uom_id', v_t.purchase_uom_id);
END;
$$;

REVOKE ALL ON FUNCTION public._resolve_purchase_line_price(uuid,uuid,uuid,numeric,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._resolve_purchase_line_price(uuid,uuid,uuid,numeric,date,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_purchase_line_price(
  p_business_id uuid, p_product_id uuid, p_supplier_id uuid DEFAULT NULL,
  p_quantity numeric DEFAULT NULL, p_on_date date DEFAULT CURRENT_DATE,
  p_branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'PURCHASE_PRICE_FORBIDDEN: no access to business %', p_business_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public._resolve_purchase_line_price(
    p_business_id, p_product_id, p_supplier_id, p_quantity, p_on_date, p_branch_id);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_purchase_line_price(uuid,uuid,uuid,numeric,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_purchase_line_price(uuid,uuid,uuid,numeric,date,uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------- Phase 4
INSERT INTO public.governance_action_registry
  (action_key, label, description, module, subject_table, subject_mode, severity_default, requires_approval_always, is_active)
VALUES
  ('supplier_terms.amend',
   'Change supplier purchasing conditions',
   'Create or change the price, currency, minimum quantity, increment or lead time a supplier offers for a product.',
   'Purchasing', 'supplier_item_terms', 'actor', 'standard', false, true)
ON CONFLICT (action_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._sit_emit(_id uuid, _state text, _payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v RECORD;
BEGIN
  SELECT t.organization_id, t.branch_id, t.updated_at, t.business_id
    INTO v FROM public.supplier_item_terms t WHERE t.id = _id;
  IF v.organization_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.business_event_outbox
    (org_id, branch_id, source, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (
    v.organization_id, v.branch_id, 'procurement',
    'procurement.supplier_terms.' || _state,
    'supplier_item_terms', _id,
    COALESCE(_payload, '{}'::jsonb) || jsonb_build_object('business_id', v.business_id),
    'procurement.supplier_terms:' || _id::text || ':' || _state || ':'
      || COALESCE(extract(epoch FROM v.updated_at)::bigint::text, '0'),
    'pending', auth.uid(), now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public._sit_emit(uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._sit_emit(uuid,text,jsonb) TO authenticated, service_role;

-- The single write path: audits, emits, and routes to the one approval engine.
CREATE OR REPLACE FUNCTION public.upsert_supplier_item_terms(
  p_business_id uuid, p_vendor_id uuid, p_product_id uuid, p_unit_price numeric,
  p_currency_code text, p_min_order_qty numeric, p_lead_time_days integer,
  p_is_preferred boolean, p_effective_from date, p_effective_to date, p_notes text,
  p_branch_id uuid DEFAULT NULL, p_organization_id uuid DEFAULT NULL, p_id uuid DEFAULT NULL,
  p_preferred_rank integer DEFAULT NULL, p_order_increment numeric DEFAULT NULL,
  p_purchase_uom_id uuid DEFAULT NULL, p_price_break_tiers jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id uuid;
  v_org uuid := p_organization_id;
  v_id uuid;
  v_old public.supplier_item_terms;
  v_new public.supplier_item_terms;
  v_rank integer;
  v_req uuid;
  v_state text;
  v_price_changed boolean;
BEGIN
  PERFORM public._assert_org_member(
    (SELECT b.organization_id FROM public.businesses b WHERE b.id = p_business_id)
  );

  IF v_org IS NULL THEN
    SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = p_business_id;
  END IF;

  v_supplier_id := public.ensure_supplier_for_contact(p_vendor_id);
  IF v_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Vendor % is not a supplier party', p_vendor_id;
  END IF;

  v_rank := COALESCE(p_preferred_rank,
                     CASE WHEN COALESCE(p_is_preferred, false) THEN 1 ELSE 10 END);

  -- Rank 1 is exclusive per product within the same branch scope.
  IF v_rank <= 1 THEN
    UPDATE public.supplier_item_terms t
       SET preferred_rank = 10, updated_at = now(), updated_by = auth.uid()
     WHERE t.business_id = p_business_id
       AND t.product_id = p_product_id
       AND t.preferred_rank <= 1
       AND (p_id IS NULL OR t.id <> p_id)
       AND t.branch_id IS NOT DISTINCT FROM p_branch_id;
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.supplier_item_terms WHERE id = p_id AND business_id = p_business_id;
    IF v_old.id IS NULL THEN
      RAISE EXCEPTION 'supplier_item_terms % not found for business %', p_id, p_business_id;
    END IF;

    UPDATE public.supplier_item_terms
       SET supplier_id       = v_supplier_id,
           product_id        = p_product_id,
           unit_price        = COALESCE(p_unit_price, unit_price),
           currency_code     = COALESCE(p_currency_code, currency_code),
           min_order_qty     = COALESCE(p_min_order_qty, min_order_qty),
           order_increment   = COALESCE(p_order_increment, order_increment),
           purchase_uom_id   = COALESCE(p_purchase_uom_id, purchase_uom_id),
           price_break_tiers = COALESCE(p_price_break_tiers, price_break_tiers),
           lead_time_days    = COALESCE(p_lead_time_days, lead_time_days),
           preferred_rank    = v_rank,
           effective_from    = COALESCE(p_effective_from, effective_from),
           effective_to      = p_effective_to,
           notes             = p_notes,
           branch_id         = p_branch_id,
           updated_by        = auth.uid(),
           updated_at        = now()
     WHERE id = p_id AND business_id = p_business_id
     RETURNING * INTO v_new;
    v_id := v_new.id;
    v_state := 'amended';
  ELSE
    INSERT INTO public.supplier_item_terms (
      organization_id, business_id, branch_id, supplier_id, product_id,
      unit_price, currency_code, min_order_qty, order_increment, purchase_uom_id,
      price_break_tiers, lead_time_days, preferred_rank,
      effective_from, effective_to, notes, is_active, created_by
    ) VALUES (
      v_org, p_business_id, p_branch_id, v_supplier_id, p_product_id,
      p_unit_price, COALESCE(p_currency_code, 'KES'), COALESCE(p_min_order_qty, 1),
      p_order_increment, p_purchase_uom_id,
      COALESCE(p_price_break_tiers, '[]'::jsonb),
      COALESCE(p_lead_time_days, 0), v_rank,
      COALESCE(p_effective_from, CURRENT_DATE), p_effective_to, p_notes, true, auth.uid()
    )
    RETURNING * INTO v_new;
    v_id := v_new.id;
    v_state := 'created';
  END IF;

  v_price_changed := (v_old.id IS NULL)
    OR (v_old.unit_price IS DISTINCT FROM v_new.unit_price)
    OR (v_old.currency_code IS DISTINCT FROM v_new.currency_code)
    OR (v_old.price_break_tiers IS DISTINCT FROM v_new.price_break_tiers);

  -- Single governance engine (ADR-0101). No rule matched => not gated.
  IF v_price_changed THEN
    v_req := (public.approval_route(
      'supplier_terms.amend', 'supplier_item_terms', v_id,
      NULL,
      jsonb_build_object('unit_price', v_new.unit_price,
                         'currency', v_new.currency_code,
                         'supplier_id', v_new.supplier_id,
                         'product_id', v_new.product_id,
                         'previous_unit_price', v_old.unit_price),
      jsonb_build_object('business_id', p_business_id, 'organization_id', v_org),
      'supplier_terms.amend:' || v_id::text || ':' || extract(epoch FROM v_new.updated_at)::bigint::text,
      p_business_id
    )->>'approval_request_id')::uuid;

    IF v_req IS NOT NULL THEN
      UPDATE public.supplier_item_terms
         SET approval_status = 'pending_approval', approval_request_id = v_req
       WHERE id = v_id;
      v_state := 'submitted';
    END IF;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, old_values, new_values)
  VALUES (v_org, p_business_id, auth.uid(),
          CASE WHEN v_old.id IS NULL THEN 'create' ELSE 'update' END,
          'supplier_item_terms', v_id, to_jsonb(v_old), to_jsonb(v_new));

  PERFORM public._sit_emit(v_id, v_state, jsonb_build_object(
    'supplier_id', v_new.supplier_id, 'product_id', v_new.product_id,
    'unit_price', v_new.unit_price, 'currency_code', v_new.currency_code,
    'previous_unit_price', v_old.unit_price));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_supplier_item_terms(uuid,uuid,uuid,numeric,text,numeric,integer,boolean,date,date,text,uuid,uuid,uuid,integer,numeric,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_supplier_item_terms(uuid,uuid,uuid,numeric,text,numeric,integer,boolean,date,date,text,uuid,uuid,uuid,integer,numeric,uuid,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._mirror_approval_to_supplier_item_terms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_t public.supplier_item_terms;
BEGIN
  IF NEW.entity_type <> 'supplier_item_terms' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v_t FROM public.supplier_item_terms WHERE id = NEW.entity_id;
  IF v_t.id IS NULL OR v_t.approval_status <> 'pending_approval' THEN RETURN NEW; END IF;

  IF NEW.status = 'approved' THEN
    UPDATE public.supplier_item_terms
       SET approval_status = 'approved', updated_at = now()
     WHERE id = NEW.entity_id;
    PERFORM public._sit_emit(NEW.entity_id, 'activated',
      jsonb_build_object('approval_request_id', NEW.id));
  ELSIF NEW.status IN ('rejected','cancelled') THEN
    UPDATE public.supplier_item_terms
       SET approval_status = 'rejected', updated_at = now()
     WHERE id = NEW.entity_id;
    PERFORM public._sit_emit(NEW.entity_id, 'rejected',
      jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mirror_approval_to_supplier_item_terms ON public.approval_requests;
CREATE TRIGGER mirror_approval_to_supplier_item_terms
AFTER INSERT OR UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_supplier_item_terms();

-- Deactivation is a lifecycle event too.
CREATE OR REPLACE FUNCTION public.deactivate_supplier_item_terms(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_t public.supplier_item_terms;
BEGIN
  SELECT * INTO v_t FROM public.supplier_item_terms WHERE id = p_id;
  IF v_t.id IS NULL THEN RETURN; END IF;
  PERFORM public._assert_org_member(v_t.organization_id);

  UPDATE public.supplier_item_terms
     SET is_active = false, updated_by = auth.uid(), updated_at = now()
   WHERE id = p_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, old_values)
  VALUES (v_t.organization_id, v_t.business_id, auth.uid(), 'deactivate',
          'supplier_item_terms', p_id, to_jsonb(v_t));

  PERFORM public._sit_emit(p_id, 'deactivated',
    jsonb_build_object('supplier_id', v_t.supplier_id, 'product_id', v_t.product_id));
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_supplier_item_terms(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_supplier_item_terms(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------- Phase 5
-- Price provenance on the agreed document, so a historical PO stays explainable.
ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS supplier_terms_id uuid REFERENCES public.supplier_item_terms(id),
  ADD COLUMN IF NOT EXISTS price_source text;

COMMENT ON COLUMN public.purchase_order_items.price_source IS
  'Which authority produced the agreed price: contract / supplier_tier / supplier_flat / product_default / manual.';

CREATE OR REPLACE FUNCTION public._po_item_stamp_price_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po RECORD;
  v_res jsonb;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.price_source IS NOT NULL AND NEW.supplier_terms_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.price_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT po.business_id, po.vendor_id, po.branch_id, po.order_date
    INTO v_po FROM public.purchase_orders po WHERE po.id = NEW.purchase_order_id;
  IF v_po.business_id IS NULL THEN RETURN NEW; END IF;

  v_res := public._resolve_purchase_line_price(
    v_po.business_id, NEW.product_id, v_po.vendor_id,
    NEW.quantity, COALESCE(v_po.order_date::date, CURRENT_DATE), v_po.branch_id);

  NEW.supplier_terms_id := COALESCE(NEW.supplier_terms_id,
                                    NULLIF(v_res->>'supplier_terms_id','')::uuid);
  NEW.contract_line_id  := COALESCE(NEW.contract_line_id,
                                    NULLIF(v_res->>'contract_line_id','')::uuid);
  NEW.contract_unit_price := COALESCE(NEW.contract_unit_price,
    CASE WHEN v_res->>'price_source' = 'contract'
         THEN NULLIF(v_res->>'unit_price','')::numeric END);

  -- Provenance records where the price CAME from. A price the operator typed
  -- that differs from every authority is honestly recorded as manual.
  NEW.price_source := COALESCE(NEW.price_source,
    CASE
      WHEN NULLIF(v_res->>'unit_price','')::numeric IS NOT NULL
       AND NEW.unit_price IS NOT DISTINCT FROM NULLIF(v_res->>'unit_price','')::numeric
      THEN v_res->>'price_source'
      ELSE 'manual'
    END);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS b_stamp_price_provenance ON public.purchase_order_items;
CREATE TRIGGER b_stamp_price_provenance
BEFORE INSERT OR UPDATE ON public.purchase_order_items
FOR EACH ROW EXECUTE FUNCTION public._po_item_stamp_price_provenance();