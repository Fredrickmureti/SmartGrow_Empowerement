CREATE TABLE public.pos_daily_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  summary_date date NOT NULL,
  total_transactions integer DEFAULT 0,
  total_revenue numeric(15,2) DEFAULT 0,
  total_tax numeric(15,2) DEFAULT 0,
  total_discounts numeric(15,2) DEFAULT 0,
  total_cogs numeric(15,2) DEFAULT 0,
  total_returns integer DEFAULT 0,
  total_return_amount numeric(15,2) DEFAULT 0,
  total_voids integer DEFAULT 0,
  total_void_amount numeric(15,2) DEFAULT 0,
  shifts_opened integer DEFAULT 0,
  shifts_closed integer DEFAULT 0,
  cash_total numeric(15,2) DEFAULT 0,
  card_total numeric(15,2) DEFAULT 0,
  mobile_money_total numeric(15,2) DEFAULT 0,
  other_payment_total numeric(15,2) DEFAULT 0,
  unique_customers integer DEFAULT 0,
  avg_transaction_value numeric(15,2) DEFAULT 0,
  items_sold integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, summary_date)
);

CREATE INDEX idx_pos_daily_summary_org_date ON public.pos_daily_summary(organization_id, summary_date DESC);
CREATE INDEX idx_pos_daily_summary_org_biz_date ON public.pos_daily_summary(organization_id, business_id, summary_date DESC);

ALTER TABLE public.pos_daily_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view summaries"
  ON public.pos_daily_summary FOR SELECT TO authenticated
  USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Org members can manage summaries"
  ON public.pos_daily_summary FOR ALL TO authenticated
  USING (is_org_member(auth.uid(), organization_id))
  WITH CHECK (is_org_member(auth.uid(), organization_id));

-- Function to refresh daily summary (called at shift close)
CREATE OR REPLACE FUNCTION public.update_pos_daily_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stats RECORD;
  v_payment_stats RECORD;
  v_shift_stats RECORD;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE status = 'completed' AND transaction_type = 'sale') AS txn_count,
    COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed' AND transaction_type = 'sale'), 0) AS revenue,
    COALESCE(SUM(tax_amount) FILTER (WHERE status = 'completed' AND transaction_type = 'sale'), 0) AS tax,
    COALESCE(SUM(discount_amount) FILTER (WHERE status = 'completed' AND transaction_type = 'sale'), 0) AS discounts,
    COUNT(*) FILTER (WHERE transaction_type = 'return') AS returns_count,
    COALESCE(ABS(SUM(total_amount) FILTER (WHERE transaction_type = 'return')), 0) AS returns_amt,
    COUNT(*) FILTER (WHERE status = 'voided') AS voids_count,
    COALESCE(ABS(SUM(total_amount) FILTER (WHERE status = 'voided')), 0) AS voids_amt,
    COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL AND status = 'completed') AS customers
  INTO v_stats
  FROM pos_transactions
  WHERE organization_id = p_organization_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND created_at::date = p_date;

  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'), 0) AS cash_t,
    COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'card'), 0) AS card_t,
    COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'mobile_money'), 0) AS mobile_t,
    COALESCE(SUM(p.amount) FILTER (WHERE p.method NOT IN ('cash', 'card', 'mobile_money')), 0) AS other_t
  INTO v_payment_stats
  FROM pos_transaction_payments p
  JOIN pos_transactions t ON t.id = p.transaction_id
  WHERE t.organization_id = p_organization_id
    AND (p_business_id IS NULL OR t.business_id = p_business_id)
    AND t.created_at::date = p_date
    AND t.status = 'completed';

  SELECT
    COUNT(*) FILTER (WHERE opened_at::date = p_date) AS opened,
    COUNT(*) FILTER (WHERE closed_at::date = p_date AND status = 'closed') AS closed
  INTO v_shift_stats
  FROM pos_shifts
  WHERE organization_id = p_organization_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (opened_at::date = p_date OR closed_at::date = p_date);

  -- Count items sold
  DECLARE v_items_sold bigint;
  BEGIN
    SELECT COALESCE(SUM(i.quantity), 0)
    INTO v_items_sold
    FROM pos_transaction_items i
    JOIN pos_transactions t ON t.id = i.transaction_id
    WHERE t.organization_id = p_organization_id
      AND (p_business_id IS NULL OR t.business_id = p_business_id)
      AND t.created_at::date = p_date
      AND t.status = 'completed'
      AND t.transaction_type = 'sale';
  END;

  INSERT INTO pos_daily_summary (
    organization_id, business_id, summary_date,
    total_transactions, total_revenue, total_tax, total_discounts,
    total_returns, total_return_amount, total_voids, total_void_amount,
    shifts_opened, shifts_closed,
    cash_total, card_total, mobile_money_total, other_payment_total,
    unique_customers, avg_transaction_value, items_sold, updated_at
  ) VALUES (
    p_organization_id, p_business_id, p_date,
    v_stats.txn_count, v_stats.revenue, v_stats.tax, v_stats.discounts,
    v_stats.returns_count, v_stats.returns_amt, v_stats.voids_count, v_stats.voids_amt,
    v_shift_stats.opened, v_shift_stats.closed,
    v_payment_stats.cash_t, v_payment_stats.card_t, v_payment_stats.mobile_t, v_payment_stats.other_t,
    v_stats.customers,
    CASE WHEN v_stats.txn_count > 0 THEN v_stats.revenue / v_stats.txn_count ELSE 0 END,
    v_items_sold, now()
  )
  ON CONFLICT (organization_id, business_id, summary_date)
  DO UPDATE SET
    total_transactions = EXCLUDED.total_transactions,
    total_revenue = EXCLUDED.total_revenue,
    total_tax = EXCLUDED.total_tax,
    total_discounts = EXCLUDED.total_discounts,
    total_returns = EXCLUDED.total_returns,
    total_return_amount = EXCLUDED.total_return_amount,
    total_voids = EXCLUDED.total_voids,
    total_void_amount = EXCLUDED.total_void_amount,
    shifts_opened = EXCLUDED.shifts_opened,
    shifts_closed = EXCLUDED.shifts_closed,
    cash_total = EXCLUDED.cash_total,
    card_total = EXCLUDED.card_total,
    mobile_money_total = EXCLUDED.mobile_money_total,
    other_payment_total = EXCLUDED.other_payment_total,
    unique_customers = EXCLUDED.unique_customers,
    avg_transaction_value = EXCLUDED.avg_transaction_value,
    items_sold = EXCLUDED.items_sold,
    updated_at = now();
END;
$$;