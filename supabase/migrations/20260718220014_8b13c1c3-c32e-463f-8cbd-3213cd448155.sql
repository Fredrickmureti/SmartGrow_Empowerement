
CREATE TABLE IF NOT EXISTS public.pos_sales_daily (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  register_id UUID NOT NULL,
  sale_date DATE NOT NULL,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  item_count NUMERIC(18,4) NOT NULL DEFAULT 0,
  gross_sales NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  tip_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  net_sales NUMERIC(18,4) NOT NULL DEFAULT 0,
  refund_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  first_sale_at TIMESTAMPTZ,
  last_sale_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, register_id, sale_date)
);

CREATE INDEX IF NOT EXISTS pos_sales_daily_org_date_idx
  ON public.pos_sales_daily (organization_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS pos_sales_daily_branch_date_idx
  ON public.pos_sales_daily (business_id, branch_id, sale_date DESC);

GRANT SELECT ON public.pos_sales_daily TO authenticated;
GRANT ALL ON public.pos_sales_daily TO service_role;

ALTER TABLE public.pos_sales_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_sales_daily_read_business_members"
  ON public.pos_sales_daily FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pos_sales_daily.business_id
    )
  );

CREATE TABLE IF NOT EXISTS public.pos_customer_purchase_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  register_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  transaction_number TEXT NOT NULL,
  sold_at TIMESTAMPTZ NOT NULL,
  item_count NUMERIC(18,4) NOT NULL DEFAULT 0,
  subtotal NUMERIC(18,4) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  tip_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  total NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS pos_customer_purchase_history_customer_idx
  ON public.pos_customer_purchase_history (business_id, customer_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS pos_customer_purchase_history_org_idx
  ON public.pos_customer_purchase_history (organization_id, sold_at DESC);

GRANT SELECT ON public.pos_customer_purchase_history TO authenticated;
GRANT ALL ON public.pos_customer_purchase_history TO service_role;

ALTER TABLE public.pos_customer_purchase_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_customer_purchase_history_read_business_members"
  ON public.pos_customer_purchase_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pos_customer_purchase_history.business_id
    )
  );

CREATE TABLE IF NOT EXISTS public.pos_projection_apply_log (
  projection_name TEXT NOT NULL,
  transaction_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projection_name, transaction_id)
);

GRANT ALL ON public.pos_projection_apply_log TO service_role;

ALTER TABLE public.pos_projection_apply_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_projection_apply_log_no_client_read"
  ON public.pos_projection_apply_log FOR SELECT
  TO authenticated
  USING (false);

CREATE OR REPLACE FUNCTION public.tg_projection_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_sales_daily_touch ON public.pos_sales_daily;
CREATE TRIGGER trg_pos_sales_daily_touch
  BEFORE UPDATE ON public.pos_sales_daily
  FOR EACH ROW EXECUTE FUNCTION public.tg_projection_touch_updated_at();

DROP TRIGGER IF EXISTS trg_pos_customer_purchase_history_touch ON public.pos_customer_purchase_history;
CREATE TRIGGER trg_pos_customer_purchase_history_touch
  BEFORE UPDATE ON public.pos_customer_purchase_history
  FOR EACH ROW EXECUTE FUNCTION public.tg_projection_touch_updated_at();

CREATE OR REPLACE FUNCTION public.project_pos_sale_committed(p_transaction_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx RECORD;
  v_item_count NUMERIC(18,4);
  v_sale_date DATE;
  v_daily_applied BOOLEAN := false;
  v_customer_applied BOOLEAN := false;
BEGIN
  SELECT
    t.id, t.organization_id, t.business_id, t.branch_id, t.register_id,
    t.customer_id, t.transaction_number, t.subtotal,
    COALESCE(t.discount_amount, 0) AS discount_amount,
    COALESCE(t.tax_amount, 0) AS tax_amount,
    COALESCE(t.tip_amount, 0) AS tip_amount,
    t.total, t.transaction_type, t.status,
    COALESCE(t.completed_at, t.created_at) AS sold_at
  INTO v_tx
  FROM public.pos_transactions t
  WHERE t.id = p_transaction_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_found');
  END IF;

  IF v_tx.status = 'voided' THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'voided');
  END IF;

  v_sale_date := (v_tx.sold_at AT TIME ZONE 'UTC')::date;

  SELECT COALESCE(SUM(quantity), 0) INTO v_item_count
  FROM public.pos_transaction_items
  WHERE transaction_id = p_transaction_id;

  INSERT INTO public.pos_projection_apply_log (projection_name, transaction_id)
  VALUES ('pos_sales_daily', p_transaction_id)
  ON CONFLICT DO NOTHING;

  IF FOUND THEN
    v_daily_applied := true;
    INSERT INTO public.pos_sales_daily (
      organization_id, business_id, branch_id, register_id, sale_date,
      transaction_count, item_count,
      gross_sales, discount_total, tax_total, tip_total, net_sales,
      refund_total, first_sale_at, last_sale_at
    ) VALUES (
      v_tx.organization_id, v_tx.business_id, v_tx.branch_id, v_tx.register_id, v_sale_date,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE 1 END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_item_count END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_tx.subtotal END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_tx.discount_amount END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_tx.tax_amount END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_tx.tip_amount END,
      CASE WHEN v_tx.transaction_type = 'return' THEN 0 ELSE v_tx.total END,
      CASE WHEN v_tx.transaction_type = 'return' THEN v_tx.total ELSE 0 END,
      v_tx.sold_at, v_tx.sold_at
    )
    ON CONFLICT (business_id, register_id, sale_date) DO UPDATE
      SET transaction_count = pos_sales_daily.transaction_count + EXCLUDED.transaction_count,
          item_count        = pos_sales_daily.item_count + EXCLUDED.item_count,
          gross_sales       = pos_sales_daily.gross_sales + EXCLUDED.gross_sales,
          discount_total    = pos_sales_daily.discount_total + EXCLUDED.discount_total,
          tax_total         = pos_sales_daily.tax_total + EXCLUDED.tax_total,
          tip_total         = pos_sales_daily.tip_total + EXCLUDED.tip_total,
          net_sales         = pos_sales_daily.net_sales + EXCLUDED.net_sales,
          refund_total      = pos_sales_daily.refund_total + EXCLUDED.refund_total,
          first_sale_at     = LEAST(pos_sales_daily.first_sale_at, EXCLUDED.first_sale_at),
          last_sale_at      = GREATEST(pos_sales_daily.last_sale_at, EXCLUDED.last_sale_at);
  END IF;

  IF v_tx.customer_id IS NOT NULL AND v_tx.transaction_type <> 'return' THEN
    INSERT INTO public.pos_customer_purchase_history (
      organization_id, business_id, branch_id, register_id, customer_id,
      transaction_id, transaction_number, sold_at, item_count,
      subtotal, discount_amount, tax_amount, tip_amount, total
    ) VALUES (
      v_tx.organization_id, v_tx.business_id, v_tx.branch_id, v_tx.register_id,
      v_tx.customer_id, v_tx.id, v_tx.transaction_number, v_tx.sold_at,
      v_item_count, v_tx.subtotal, v_tx.discount_amount, v_tx.tax_amount,
      v_tx.tip_amount, v_tx.total
    )
    ON CONFLICT (transaction_id) DO NOTHING;

    IF FOUND THEN v_customer_applied := true; END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'daily_applied', v_daily_applied,
    'customer_history_applied', v_customer_applied
  );
END;
$$;

REVOKE ALL ON FUNCTION public.project_pos_sale_committed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_pos_sale_committed(UUID) TO service_role;
