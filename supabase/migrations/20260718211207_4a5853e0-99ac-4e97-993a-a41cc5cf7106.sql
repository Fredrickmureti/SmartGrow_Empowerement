
-- Phase E — durable loyalty accrual triggered by pos.sale.committed
CREATE OR REPLACE FUNCTION public.apply_loyalty_accrual_for_sale(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn        public.pos_transactions%ROWTYPE;
  v_program    public.loyalty_programs%ROWTYPE;
  v_loyalty    public.customer_loyalty%ROWTYPE;
  v_points     numeric;
  v_existing   uuid;
BEGIN
  SELECT * INTO v_txn FROM public.pos_transactions WHERE id = p_transaction_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', 'not_found');
  END IF;

  -- Returns don't accrue; only sales with a linked customer.
  IF v_txn.transaction_type <> 'sale' OR v_txn.customer_id IS NULL THEN
    RETURN jsonb_build_object('skipped', 'not_eligible');
  END IF;

  -- Idempotent: if we already booked points for this transaction, no-op.
  SELECT id INTO v_existing
    FROM public.loyalty_transactions
   WHERE pos_transaction_id = p_transaction_id
     AND transaction_type = 'earned'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', 'already_accrued');
  END IF;

  -- Find the active loyalty program for this business (fallback to org).
  SELECT * INTO v_program
    FROM public.loyalty_programs
   WHERE is_active = true
     AND (business_id = v_txn.business_id OR business_id IS NULL)
     AND organization_id = v_txn.organization_id
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', 'no_program');
  END IF;

  v_points := floor(COALESCE(v_txn.total, 0) * COALESCE(v_program.points_per_currency, 1));
  IF v_points <= 0 THEN
    RETURN jsonb_build_object('skipped', 'zero_points');
  END IF;

  -- Ensure customer_loyalty row.
  SELECT * INTO v_loyalty
    FROM public.customer_loyalty
   WHERE contact_id = v_txn.customer_id
     AND program_id = v_program.id
   LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.customer_loyalty (
      contact_id, program_id, organization_id, business_id,
      points_balance, points_earned_total, points_redeemed_total,
      current_tier, total_spent, visit_count, last_visit
    ) VALUES (
      v_txn.customer_id, v_program.id, v_txn.organization_id, v_txn.business_id,
      v_points, v_points, 0, 'bronze', COALESCE(v_txn.total, 0), 1, now()
    )
    RETURNING * INTO v_loyalty;
  ELSE
    UPDATE public.customer_loyalty
       SET points_balance       = points_balance + v_points,
           points_earned_total  = points_earned_total + v_points,
           total_spent          = total_spent + COALESCE(v_txn.total, 0),
           visit_count          = visit_count + 1,
           last_visit           = now(),
           updated_at           = now()
     WHERE id = v_loyalty.id
     RETURNING * INTO v_loyalty;
  END IF;

  INSERT INTO public.loyalty_transactions (
    customer_loyalty_id, pos_transaction_id, points_change,
    transaction_type, description, created_by
  ) VALUES (
    v_loyalty.id, p_transaction_id, v_points,
    'earned',
    'POS sale ' || COALESCE(v_txn.transaction_number, p_transaction_id::text),
    v_txn.cashier_id
  );

  RETURN jsonb_build_object(
    'accrued', true,
    'points', v_points,
    'customer_loyalty_id', v_loyalty.id,
    'program_id', v_program.id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.apply_loyalty_accrual_for_sale(uuid) TO service_role;
