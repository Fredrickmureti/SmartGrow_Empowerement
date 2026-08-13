-- Phase 2R.1 — resolve_product_measure fails closed and picks a deterministic target unit.
CREATE OR REPLACE FUNCTION public.resolve_product_measure(
  p_business uuid,
  p_product uuid,
  p_packaging uuid,
  p_measure text,
  p_target_uom uuid DEFAULT NULL::uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_value numeric;
  v_uom   uuid;
  v_dim   text;
  v_target uuid := p_target_uom;
  v_pack_qty numeric;
BEGIN
  IF p_measure NOT IN ('net_weight','tare_weight','gross_weight','volume') THEN
    RAISE EXCEPTION 'resolve_product_measure: unsupported measure %', p_measure;
  END IF;

  v_dim := CASE WHEN p_measure = 'volume' THEN 'volume' ELSE 'mass' END;

  -- Exact level first.
  SELECT CASE p_measure
           WHEN 'net_weight'   THEN a.net_weight
           WHEN 'tare_weight'  THEN a.tare_weight
           WHEN 'gross_weight' THEN a.gross_weight
           ELSE a.volume
         END,
         CASE p_measure
           WHEN 'net_weight'   THEN a.net_weight_uom_id
           WHEN 'tare_weight'  THEN a.tare_weight_uom_id
           WHEN 'gross_weight' THEN a.gross_weight_uom_id
           ELSE a.volume_uom_id
         END
    INTO v_value, v_uom
    FROM public.product_physical_attributes a
   WHERE a.product_id = p_product
     AND a.packaging_id IS NOT DISTINCT FROM p_packaging;

  -- Fall back from a packaging level to base unit x pack size.
  IF v_value IS NULL AND p_packaging IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty
      FROM public.product_packaging WHERE id = p_packaging;

    SELECT CASE p_measure
             WHEN 'net_weight'   THEN a.net_weight
             WHEN 'tare_weight'  THEN a.tare_weight
             WHEN 'gross_weight' THEN a.gross_weight
             ELSE a.volume
           END,
           CASE p_measure
             WHEN 'net_weight'   THEN a.net_weight_uom_id
             WHEN 'tare_weight'  THEN a.tare_weight_uom_id
             WHEN 'gross_weight' THEN a.gross_weight_uom_id
             ELSE a.volume_uom_id
           END
      INTO v_value, v_uom
      FROM public.product_physical_attributes a
     WHERE a.product_id = p_product AND a.packaging_id IS NULL;

    IF v_value IS NOT NULL AND COALESCE(v_pack_qty, 0) > 0 THEN
      v_value := v_value * v_pack_qty;
    END IF;
  END IF;

  -- Absence of the fact is a legitimate NULL: the caller decides whether to
  -- refuse. An unconvertible fact is NOT — that must never be summed.
  IF v_value IS NULL OR v_uom IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_target IS NULL THEN
    -- Deterministic: the oldest category of this dimension in the business
    -- that actually declares a reference unit.
    SELECT c.reference_uom_id INTO v_target
      FROM public.uom_categories c
     WHERE c.business_id = p_business
       AND c.dimension = v_dim
       AND c.reference_uom_id IS NOT NULL
     ORDER BY c.created_at, c.id
     LIMIT 1;
  END IF;

  IF v_target IS NULL THEN
    -- Fail closed. Returning the captured value here would let measurements in
    -- different units be summed as if they shared one unit.
    RAISE EXCEPTION
      'no reference unit configured for % measurements in this business — configure the % unit-of-measure category before using physical measures',
      v_dim, v_dim
      USING ERRCODE = 'P0001';
  END IF;

  RETURN public.convert_uom(v_value, v_uom, v_target);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_product_measure(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_measure(uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

-- Phase 2R.2 — allocation measures each line at its own packaging level.
CREATE OR REPLACE FUNCTION public.landed_cost_allocate_voucher(p_voucher_id uuid, p_actor uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_voucher RECORD;
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_comp RECORD;
  v_line RECORD;
  v_basis_total numeric;
  v_amount numeric;
  v_running numeric;
  v_last_alloc uuid;
  v_share numeric;
  v_skipped jsonb := '[]'::jsonb;
  v_lines integer := 0;
  v_total_allocated numeric := 0;
  v_missing text;
BEGIN
  SELECT * INTO v_voucher FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v_voucher.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v_voucher.status NOT IN ('draft', 'pending_approval', 'allocated') THEN
    RAISE EXCEPTION 'voucher % is % and cannot be allocated', p_voucher_id, v_voucher.status
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.landed_cost_voucher_receipts WHERE voucher_id = p_voucher_id) THEN
    RAISE EXCEPTION 'voucher % has no goods receipts in scope', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.landed_cost_components WHERE voucher_id = p_voucher_id AND amount > 0) THEN
    RAISE EXCEPTION 'voucher % has no cost components to allocate', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  -- Eligible target lines: inventory-tracked products received in scope.
  --
  -- Physical bases are measured at the level the line was actually received in:
  -- when the receipt line carries a packaging level and a display quantity, the
  -- measure is per package x number of packages. Otherwise it is the base-unit
  -- measure x base quantity. resolve_product_measure itself falls back from a
  -- packaging level to base x pack size, so a case always weighs a case.
  CREATE TEMP TABLE tmp_lc_targets ON COMMIT DROP AS
  WITH src AS (
    SELECT gri.id AS gri_id,
           gr.id AS grn_id,
           gr.purchase_order_id,
           gri.product_id,
           p.name AS product_name,
           COALESCE(gri.quantity_received, 0) AS qty,
           COALESCE(gri.quantity_received, 0) * COALESCE(poi.unit_price, 0) AS line_value,
           CASE
             WHEN gri.packaging_id IS NOT NULL AND COALESCE(gri.display_quantity, 0) > 0
               THEN gri.packaging_id
             ELSE NULL
           END AS measure_packaging_id,
           CASE
             WHEN gri.packaging_id IS NOT NULL AND COALESCE(gri.display_quantity, 0) > 0
               THEN gri.display_quantity
             ELSE COALESCE(gri.quantity_received, 0)
           END AS measure_qty
      FROM public.landed_cost_voucher_receipts lvr
      JOIN public.goods_receipts gr ON gr.id = lvr.goods_receipt_id
      JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = gr.id
      JOIN public.products p ON p.id = gri.product_id
      LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
     WHERE lvr.voucher_id = p_voucher_id
       AND p.track_inventory IS TRUE
       AND COALESCE(gri.quantity_received, 0) > 0
  )
  SELECT src.gri_id,
         src.grn_id,
         src.purchase_order_id,
         src.product_id,
         src.product_name,
         src.qty,
         src.line_value,
         src.measure_qty * COALESCE(
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'gross_weight'),
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'net_weight')
         ) AS line_weight,
         src.measure_qty *
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'volume')
           AS line_volume
    FROM src;

  SELECT jsonb_agg(jsonb_build_object(
           'goods_receipt_item_id', gri.id,
           'product_id', gri.product_id,
           'reason', CASE WHEN gri.product_id IS NULL THEN 'no_product'
                          WHEN COALESCE(gri.quantity_received, 0) <= 0 THEN 'zero_quantity'
                          ELSE 'not_inventory_tracked' END))
    INTO v_skipped
    FROM public.landed_cost_voucher_receipts lvr
    JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = lvr.goods_receipt_id
    LEFT JOIN public.products p ON p.id = gri.product_id
   WHERE lvr.voucher_id = p_voucher_id
     AND (gri.product_id IS NULL
          OR p.track_inventory IS NOT TRUE
          OR COALESCE(gri.quantity_received, 0) <= 0);

  IF NOT EXISTS (SELECT 1 FROM tmp_lc_targets) THEN
    RAISE EXCEPTION 'no inventory-eligible receipt lines in scope for voucher %', p_voucher_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_voucher.exchange_rate IS NULL OR v_voucher.exchange_rate <= 0 THEN
    RAISE EXCEPTION
      'voucher % has no exchange rate on file for % — a landed cost cannot be allocated at parity',
      p_voucher_id, v_voucher.currency
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.landed_cost_allocations WHERE voucher_id = p_voucher_id;

  FOR v_comp IN
    SELECT c.*, COALESCE(c.basis, v_voucher.default_basis) AS eff_basis
      FROM public.landed_cost_components c
     WHERE c.voucher_id = p_voucher_id AND c.amount > 0
     ORDER BY c.sort_order, c.created_at
  LOOP
    IF v_comp.eff_basis = 'manual' THEN
      -- Manual components keep whatever the user entered; nothing to compute.
      CONTINUE;
    END IF;

    -- Fail closed when a physical basis is requested but the Product domain
    -- does not yet hold the fact for every line in scope.
    IF v_comp.eff_basis IN ('weight', 'volume') THEN
      SELECT string_agg(DISTINCT COALESCE(product_name, product_id::text), ', ')
        INTO v_missing
        FROM tmp_lc_targets
       WHERE CASE WHEN v_comp.eff_basis = 'weight' THEN line_weight ELSE line_volume END IS NULL
          OR CASE WHEN v_comp.eff_basis = 'weight' THEN line_weight ELSE line_volume END <= 0;

      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          'cannot allocate component % by %: no % recorded for %  — capture the product physical attributes first',
          COALESCE(v_comp.description, v_comp.id::text), v_comp.eff_basis, v_comp.eff_basis, v_missing
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_amount := ROUND(v_comp.amount * v_voucher.exchange_rate, 2);

    SELECT CASE v_comp.eff_basis
             WHEN 'value'  THEN COALESCE(SUM(line_value), 0)
             WHEN 'weight' THEN COALESCE(SUM(line_weight), 0)
             WHEN 'volume' THEN COALESCE(SUM(line_volume), 0)
             ELSE COALESCE(SUM(qty), 0)
           END
      INTO v_basis_total FROM tmp_lc_targets;

    IF v_basis_total <= 0 THEN
      RAISE EXCEPTION
        'cannot allocate component % by %: total basis is zero across the receipts in scope',
        COALESCE(v_comp.description, v_comp.id::text), v_comp.eff_basis
        USING ERRCODE = 'P0001';
    END IF;

    v_running := 0;
    v_last_alloc := NULL;

    FOR v_line IN SELECT * FROM tmp_lc_targets ORDER BY gri_id LOOP
      v_share := CASE v_comp.eff_basis
                   WHEN 'value'  THEN v_line.line_value
                   WHEN 'weight' THEN v_line.line_weight
                   WHEN 'volume' THEN v_line.line_volume
                   ELSE v_line.qty
                 END;
      IF v_share IS NULL OR v_share <= 0 THEN CONTINUE; END IF;

      INSERT INTO public.landed_cost_allocations (
        organization_id, business_id, voucher_id, component_id,
        goods_receipt_id, goods_receipt_item_id, purchase_order_id, product_id,
        basis, basis_value, allocation_ratio, allocated_amount
      ) VALUES (
        v_voucher.organization_id, v_voucher.business_id, p_voucher_id, v_comp.id,
        v_line.grn_id, v_line.gri_id, v_line.purchase_order_id, v_line.product_id,
        v_comp.eff_basis, v_share, v_share / v_basis_total,
        ROUND(v_amount * v_share / v_basis_total, 2)
      ) RETURNING id, allocated_amount INTO v_last_alloc, v_share;

      v_running := v_running + v_share;
      v_lines := v_lines + 1;
    END LOOP;

    -- Absorb rounding drift on the final allocation of this component.
    IF v_last_alloc IS NOT NULL AND v_running <> v_amount THEN
      UPDATE public.landed_cost_allocations
         SET allocated_amount = allocated_amount + (v_amount - v_running)
       WHERE id = v_last_alloc;
    END IF;

    v_total_allocated := v_total_allocated + v_amount;
  END LOOP;

  -- Manual components: trust the amounts already captured against receipt lines.
  SELECT v_total_allocated + COALESCE(SUM(allocated_amount), 0)
    INTO v_total_allocated
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_components c ON c.id = a.component_id
   WHERE a.voucher_id = p_voucher_id AND a.is_manual IS TRUE;

  UPDATE public.landed_cost_vouchers
     SET status = 'allocated', allocated_at = now(), allocated_by = v_actor
   WHERE id = p_voucher_id;

  DROP TABLE IF EXISTS tmp_lc_targets;

  RETURN jsonb_build_object(
    'voucher_id', p_voucher_id,
    'status', 'allocated',
    'allocation_lines', v_lines,
    'allocated_amount', v_total_allocated,
    'skipped_lines', COALESCE(v_skipped, '[]'::jsonb)
  );
END;
$function$;

-- Phase 2R.3 — capitalisation resolves Inventory / COGS per product through the
-- canonical product account ladder (ADR 0122) with the company role mapping as
-- the final fallback.
CREATE OR REPLACE FUNCTION public._landed_cost_post_apply(p_voucher_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v RECORD;
  v_actor uuid := p_actor;
  v_date date;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_clearing_acct uuid;
  v_line_inv_acct uuid;
  v_line_cogs_acct uuid;
  v_target RECORD;
  v_res jsonb;
  v_cap numeric;
  v_exp numeric;
  v_cap_total numeric := 0;
  v_exp_total numeric := 0;
  v_noncap RECORD;
  v_bucket RECORD;
  v_lines jsonb := '[]'::jsonb;
  v_credit_total numeric := 0;
  v_je_id uuid;
BEGIN
  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: a retried post of an already-posted voucher is a no-op.
  IF v.status = 'posted' THEN
    RETURN jsonb_build_object(
      'voucher_id', p_voucher_id, 'status', 'posted',
      'journal_entry_id', v.journal_entry_id,
      'capitalized_amount', v.capitalized_amount,
      'expensed_amount', v.expensed_amount,
      'already_posted', true);
  END IF;

  IF v.status NOT IN ('allocated', 'pending_approval') THEN
    RAISE EXCEPTION 'voucher % must be allocated before posting (currently %)', p_voucher_id, v.status
      USING ERRCODE = 'P0001';
  END IF;

  v_date := COALESCE(v.posting_date, v.voucher_date, CURRENT_DATE);

  IF public.is_period_locked(v.organization_id, v.business_id, v_date) THEN
    RAISE EXCEPTION 'accounting period for % is closed', v_date USING ERRCODE = 'P0001';
  END IF;

  -- Business-level fallbacks (company role mapping).
  v_inventory_acct := public.resolve_posting_account(v.business_id, 'inventory', v.branch_id);
  v_cogs_acct := public.resolve_posting_account(v.business_id, 'cogs', v.branch_id);
  v_clearing_acct := public.resolve_posting_account(v.business_id, 'landed_cost_clearing', v.branch_id);

  IF v_clearing_acct IS NULL THEN
    RAISE EXCEPTION 'no Landed Cost Clearing account configured — map the "landed_cost_clearing" role first'
      USING ERRCODE = 'P0001';
  END IF;

  CREATE TEMP TABLE tmp_lc_post_buckets (
    account_id uuid NOT NULL,
    kind text NOT NULL,
    amount numeric NOT NULL
  ) ON COMMIT DROP;

  FOR v_target IN
    SELECT a.goods_receipt_item_id AS gri_id,
           MIN(a.product_id::text)::uuid AS product_id,
           SUM(a.allocated_amount) AS amount
      FROM public.landed_cost_allocations a
      JOIN public.landed_cost_components c ON c.id = a.component_id
     WHERE a.voucher_id = p_voucher_id
       AND c.is_capitalizable IS TRUE
     GROUP BY a.goods_receipt_item_id
    HAVING SUM(a.allocated_amount) <> 0
  LOOP
    v_res := public.inventory_apply_cost_revaluation(
      v_target.gri_id, v_target.amount, 'landed_cost_voucher', p_voucher_id, v_actor);

    v_cap := COALESCE((v_res->>'capitalized')::numeric, 0);
    v_exp := COALESCE((v_res->>'expensed')::numeric, 0);

    -- Canonical product account ladder first; company role mapping as fallback.
    v_line_inv_acct := COALESCE(
      public.resolve_product_gl_account(v.organization_id, v.business_id, v_target.product_id, 'inventory'),
      v_inventory_acct);
    v_line_cogs_acct := COALESCE(
      public.resolve_product_gl_account(v.organization_id, v.business_id, v_target.product_id, 'cogs'),
      v_cogs_acct);

    IF v_cap <> 0 THEN
      IF v_line_inv_acct IS NULL THEN
        RAISE EXCEPTION 'no Inventory account resolvable for product % on this landed cost', v_target.product_id
          USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO tmp_lc_post_buckets VALUES (v_line_inv_acct, 'inventory', v_cap);
    END IF;

    IF v_exp <> 0 THEN
      IF v_line_cogs_acct IS NULL THEN
        RAISE EXCEPTION
          'part of this landed cost belongs to stock already sold, but no Cost of Goods Sold account is configured for product %',
          v_target.product_id
          USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO tmp_lc_post_buckets VALUES (v_line_cogs_acct, 'cogs', v_exp);
    END IF;

    v_cap_total := v_cap_total + v_cap;
    v_exp_total := v_exp_total + v_exp;

    UPDATE public.landed_cost_allocations a
       SET capitalized_amount = ROUND(a.allocated_amount
             * v_cap / NULLIF(v_target.amount, 0), 2),
           expensed_amount = a.allocated_amount - ROUND(a.allocated_amount
             * v_cap / NULLIF(v_target.amount, 0), 2),
           revaluation_result = v_res
     WHERE a.voucher_id = p_voucher_id
       AND a.goods_receipt_item_id = v_target.gri_id;
  END LOOP;

  FOR v_bucket IN
    SELECT account_id, kind, SUM(amount) AS amount
      FROM tmp_lc_post_buckets
     GROUP BY account_id, kind
    HAVING SUM(amount) <> 0
     ORDER BY kind, account_id
  LOOP
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_bucket.account_id, 'debit', v_bucket.amount, 'credit', 0,
      'description', CASE WHEN v_bucket.kind = 'inventory'
                          THEN 'Landed cost capitalised to inventory — '
                          ELSE 'Landed cost on stock already sold — ' END
                     || COALESCE(v.voucher_number, '')));
  END LOOP;

  v_credit_total := v_cap_total + v_exp_total;

  FOR v_noncap IN
    SELECT c.id, c.description, c.base_amount,
           COALESCE(c.expense_account_id, t.expense_account_id) AS account_id
      FROM public.landed_cost_components c
      LEFT JOIN public.landed_cost_component_types t ON t.id = c.component_type_id
     WHERE c.voucher_id = p_voucher_id
       AND c.is_capitalizable IS NOT TRUE
       AND c.base_amount <> 0
  LOOP
    IF v_noncap.account_id IS NULL THEN
      RAISE EXCEPTION 'non-capitalisable charge "%" has no expense account',
        COALESCE(v_noncap.description, v_noncap.id::text) USING ERRCODE = 'P0001';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_noncap.account_id, 'debit', v_noncap.base_amount, 'credit', 0,
      'description', COALESCE(v_noncap.description, 'Landed cost charge')));
    v_credit_total := v_credit_total + v_noncap.base_amount;
  END LOOP;

  IF v_credit_total = 0 THEN
    RAISE EXCEPTION 'voucher % has nothing to post', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_clearing_acct, 'debit', 0, 'credit', v_credit_total,
    'description', 'Landed cost clearing — ' || COALESCE(v.voucher_number, ''),
    'contact_id', v.vendor_id));

  v_je_id := public.post_journal_entry_atomic(
    v.organization_id, v.business_id,
    public.generate_next_je_number(v.organization_id, v.business_id),
    v_date,
    COALESCE(v.voucher_number, 'Landed cost'),
    'Landed cost voucher ' || COALESCE(v.voucher_number, p_voucher_id::text),
    'landed_cost_voucher', p_voucher_id, v_actor, false, false,
    v_lines, v.currency, v.exchange_rate, 'main', v.branch_id);

  UPDATE public.landed_cost_vouchers
     SET status = 'posted', posted_at = now(), posted_by = v_actor,
         posting_date = v_date, journal_entry_id = v_je_id,
         capitalized_amount = v_cap_total, expensed_amount = v_exp_total
   WHERE id = p_voucher_id;

  DROP TABLE IF EXISTS tmp_lc_post_buckets;

  PERFORM public._emit_landed_cost_outbox(p_voucher_id, 'posted',
    jsonb_build_object(
      'business_id', v.business_id,
      'voucher_id', p_voucher_id,
      'voucher_number', v.voucher_number,
      'capitalized_amount', v_cap_total,
      'expensed_amount', v_exp_total,
      'journal_entry_id', v_je_id));

  RETURN jsonb_build_object(
    'voucher_id', p_voucher_id, 'status', 'posted',
    'journal_entry_id', v_je_id,
    'capitalized_amount', v_cap_total,
    'expensed_amount', v_exp_total);
END;
$function$;