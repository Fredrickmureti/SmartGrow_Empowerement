-- ===== Step 7: Explicit POS lineage on invoices =====
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_pos_transaction_id uuid
    REFERENCES public.pos_transactions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_invoices_source_pos_transaction_id
  ON public.invoices (source_pos_transaction_id)
  WHERE source_pos_transaction_id IS NOT NULL;

-- Backfill from existing pos_credit invoices
UPDATE public.invoices
SET source_pos_transaction_id = source_recurring_id
WHERE source = 'pos_credit'
  AND source_recurring_id IS NOT NULL
  AND source_pos_transaction_id IS NULL
  AND EXISTS (SELECT 1 FROM public.pos_transactions t WHERE t.id = source_recurring_id);

-- Updated lineage trigger: prefer source_pos_transaction_id, fall back to source_recurring_id
CREATE OR REPLACE FUNCTION public.enforce_pos_credit_invoice_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_txn_id uuid;
  v_txn_biz uuid;
  v_txn_branch uuid;
BEGIN
  IF NEW.source IS DISTINCT FROM 'pos_credit' THEN RETURN NEW; END IF;
  v_txn_id := COALESCE(NEW.source_pos_transaction_id, NEW.source_recurring_id);
  IF v_txn_id IS NULL THEN RETURN NEW; END IF;

  SELECT business_id, branch_id INTO v_txn_biz, v_txn_branch
  FROM public.pos_transactions WHERE id = v_txn_id;
  IF v_txn_biz IS NULL THEN RETURN NEW; END IF;

  IF NEW.business_id <> v_txn_biz THEN
    RAISE EXCEPTION 'POS-credit invoice business_id (%) must match originating POS transaction (%)',
      NEW.business_id, v_txn_biz USING ERRCODE='23514';
  END IF;
  IF v_txn_branch IS NOT NULL AND (NEW.branch_id IS DISTINCT FROM v_txn_branch) THEN
    NEW.branch_id := v_txn_branch;
  END IF;
  RETURN NEW;
END $function$;

-- ===== Step 6: POS readiness check =====
CREATE OR REPLACE FUNCTION public.ensure_pos_ready_for_business(_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_payment_count int;
  v_branches_missing_wh int;
BEGIN
  IF _business_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'missing', ARRAY['business_id']);
  END IF;

  -- At least one enabled payment method for this business
  SELECT count(*) INTO v_payment_count
  FROM public.pos_payment_methods
  WHERE business_id = _business_id AND is_enabled = true;

  IF v_payment_count = 0 THEN
    v_missing := array_append(v_missing, 'payment_methods');
  END IF;

  -- Every branch that has at least one register must have a default warehouse
  SELECT count(DISTINCT b.id) INTO v_branches_missing_wh
  FROM public.branches b
  JOIN public.pos_registers r ON r.branch_id = b.id AND r.business_id = _business_id
  WHERE b.business_id = _business_id
    AND NOT EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.branch_id = b.id
        AND w.business_id = _business_id
        AND COALESCE(w.is_active, true) = true
    );

  IF v_branches_missing_wh > 0 THEN
    v_missing := array_append(v_missing, 'branch_warehouse');
  END IF;

  RETURN jsonb_build_object(
    'ok', (array_length(v_missing, 1) IS NULL),
    'missing', v_missing
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_pos_ready_for_business(uuid) TO authenticated;

-- ===== Step 9: POS install seeder (idempotent) =====
CREATE OR REPLACE FUNCTION public.seed_pos_defaults_for_business(_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_existing int;
  v_created int := 0;
BEGIN
  IF _business_id IS NULL THEN RAISE EXCEPTION 'business_id required'; END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = _business_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'business % not found', _business_id; END IF;

  SELECT count(*) INTO v_existing
  FROM public.pos_payment_methods
  WHERE business_id = _business_id;

  IF v_existing = 0 THEN
    INSERT INTO public.pos_payment_methods
      (organization_id, business_id, method_key, display_name, is_enabled, sort_order)
    VALUES
      (v_org_id, _business_id, 'cash',         'Cash',          true, 1),
      (v_org_id, _business_id, 'card',         'Card',          true, 2),
      (v_org_id, _business_id, 'mpesa',        'M-Pesa',        true, 3),
      (v_org_id, _business_id, 'bank_transfer','Bank Transfer', true, 4),
      (v_org_id, _business_id, 'credit',       'Store Credit',  true, 5),
      (v_org_id, _business_id, 'other',        'Other',         false, 6);
    v_created := 6;
  END IF;

  RETURN jsonb_build_object('payment_methods_created', v_created);
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_pos_defaults_for_business(uuid) TO authenticated;