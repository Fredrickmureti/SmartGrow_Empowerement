
DO $$
DECLARE
  v_biz UUID := gen_random_uuid();
  v_supplier UUID := gen_random_uuid();
  v_product UUID := gen_random_uuid();
  v_row UUID;
  v_caught BOOLEAN;
BEGIN
  INSERT INTO public.supplier_item_terms (
    business_id, product_id, supplier_id, preferred_rank, lead_time_days,
    price_break_tiers, effective_from, effective_to
  ) VALUES (
    v_biz, v_product, v_supplier, 1, 7,
    '[{"min_qty":1,"unit_price":10},{"min_qty":10,"unit_price":9},{"min_qty":100,"unit_price":8}]'::jsonb,
    '2026-01-01', '2026-06-30'
  ) RETURNING id INTO v_row;

  UPDATE public.supplier_item_terms SET lead_time_days = 5 WHERE id = v_row;

  v_caught := false;
  BEGIN
    INSERT INTO public.supplier_item_terms (
      business_id, product_id, supplier_id, effective_from, effective_to
    ) VALUES (v_biz, v_product, v_supplier, '2026-05-01', '2026-08-01');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%overlap%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'D5-smoke: overlap rejection MISSING'; END IF;

  v_caught := false;
  BEGIN
    INSERT INTO public.supplier_item_terms (
      business_id, product_id, supplier_id, effective_from, price_break_tiers
    ) VALUES (v_biz, v_product, gen_random_uuid(), '2026-01-01',
      '[{"min_qty":10,"unit_price":9},{"min_qty":5,"unit_price":8}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%increasing%' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'D5-smoke: non-monotonic tier rejection MISSING'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.governance_duties WHERE duty_code='supplier_terms.manage') THEN
    RAISE EXCEPTION 'D5-smoke: duty missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.governance_sod_conflicts
    WHERE (duty_a,duty_b) = ('po.approve','supplier_terms.manage')
  ) THEN
    RAISE EXCEPTION 'D5-smoke: SoD missing';
  END IF;

  RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = '__SMOKE_ROLLBACK_MARKER__' THEN
    RAISE NOTICE 'D5-smoke: PASS';
    RETURN;
  END IF;
  RAISE;
END $$;
