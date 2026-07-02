-- =========================================================
-- Stage C.1 — Backfill pos_split_bills.business_id / branch_id
-- =========================================================
UPDATE public.pos_split_bills sb
SET business_id = ts.business_id,
    branch_id = COALESCE(sb.branch_id, ts.branch_id)
FROM public.pos_table_sessions ts
WHERE sb.table_session_id = ts.id
  AND (sb.business_id IS NULL OR sb.branch_id IS NULL);

-- Enforce non-null going forward (only if all rows now have a value)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pos_split_bills WHERE business_id IS NULL) THEN
    ALTER TABLE public.pos_split_bills ALTER COLUMN business_id SET NOT NULL;
  END IF;
END$$;

-- Trigger to keep pos_split_bills aligned with its parent table session
CREATE OR REPLACE FUNCTION public.enforce_split_bill_session_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_business uuid;
  v_session_branch uuid;
BEGIN
  SELECT business_id, branch_id INTO v_session_business, v_session_branch
  FROM public.pos_table_sessions WHERE id = NEW.table_session_id;

  IF v_session_business IS NULL THEN
    RAISE EXCEPTION 'pos_split_bills: parent table session % not found', NEW.table_session_id;
  END IF;

  IF NEW.business_id IS NULL THEN
    NEW.business_id := v_session_business;
  ELSIF NEW.business_id <> v_session_business THEN
    RAISE EXCEPTION 'pos_split_bills.business_id (%) does not match parent session business (%)',
      NEW.business_id, v_session_business;
  END IF;

  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := v_session_branch;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_split_bill_session_match ON public.pos_split_bills;
CREATE TRIGGER trg_enforce_split_bill_session_match
  BEFORE INSERT OR UPDATE ON public.pos_split_bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_split_bill_session_match();

-- =========================================================
-- Stage C.2 — Attach enforce_branch_business_match trigger to every
-- operational table that has both columns but is missing the trigger.
-- =========================================================
DO $$
DECLARE
  t text;
  missing text[] := ARRAY[
    'employees',
    'fixed_assets',
    'journal_entry_lines',
    'pos_cash_movements',
    'pos_cashiers',
    'pos_daily_sales_summary',
    'pos_happy_hours',
    'pos_hardware_configs',
    'pos_held_transactions',
    'pos_kitchen_orders',
    'pos_manager_overrides',
    'pos_payment_methods',
    'pos_registers',
    'pos_security_settings',
    'pos_settings',
    'pos_shifts',
    'pos_split_bills',
    'pos_stock_reservations',
    'pos_table_bookings',
    'pos_table_sessions',
    'pos_tables',
    'pos_transactions',
    'pos_waitlist',
    'projects',
    'user_branch_assignments',
    'warehouse_stock',
    'warehouses'
  ];
BEGIN
  FOREACH t IN ARRAY missing LOOP
    -- Skip if table has no branch_id column (defensive)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='branch_id'
    ) THEN CONTINUE; END IF;

    -- Skip if trigger already exists
    IF EXISTS (
      SELECT 1 FROM pg_trigger tr
      JOIN pg_class c ON c.oid = tr.tgrelid
      WHERE c.relname = t AND tr.tgname = format('trg_%s_branch_business_match', t)
    ) THEN CONTINUE; END IF;

    EXECUTE format($f$
      CREATE TRIGGER %I
      BEFORE INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();
    $f$, 'trg_'||t||'_branch_business_match', t);
  END LOOP;
END$$;

-- =========================================================
-- Stage C.3 — Tighten the sms_log UPDATE policy (service role only)
-- =========================================================
DROP POLICY IF EXISTS "Service role can update SMS logs" ON public.sms_log;
CREATE POLICY "Service role can update SMS logs"
  ON public.sms_log
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =========================================================
-- Stage C.4 — Cross-company isolation verifier
-- =========================================================
CREATE OR REPLACE FUNCTION public.verify_company_isolation()
RETURNS TABLE (
  table_name text,
  record_id uuid,
  expected_business_id uuid,
  actual_business_id uuid,
  detail text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Journal entry lines vs parent journal entry
  SELECT 'journal_entry_lines'::text, jel.id, je.business_id, jel.business_id,
         'JE line business mismatch with parent journal_entry'::text
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.business_id IS DISTINCT FROM je.business_id

  UNION ALL
  -- Bill payments vs bill
  SELECT 'bill_payments'::text, bp.id, b.business_id, bp.business_id,
         'bill_payment business mismatch with parent bill'::text
  FROM public.bill_payments bp
  JOIN public.bills b ON b.id = bp.bill_id
  WHERE bp.business_id IS DISTINCT FROM b.business_id

  UNION ALL
  -- Stock movements vs product
  SELECT 'stock_movements'::text, sm.id, p.business_id, sm.business_id,
         'stock_movement business mismatch with product'::text
  FROM public.stock_movements sm
  JOIN public.products p ON p.id = sm.product_id
  WHERE sm.business_id IS DISTINCT FROM p.business_id

  UNION ALL
  -- POS transactions vs register
  SELECT 'pos_transactions'::text, pt.id, pr.business_id, pt.business_id,
         'pos_transaction business mismatch with register'::text
  FROM public.pos_transactions pt
  JOIN public.pos_registers pr ON pr.id = pt.register_id
  WHERE pt.business_id IS DISTINCT FROM pr.business_id

  UNION ALL
  -- Branch vs business: any branch attached to record where branch's business != record business
  SELECT 'invoices'::text, i.id, br.business_id, i.business_id,
         'invoice.branch_id belongs to a different business'::text
  FROM public.invoices i
  JOIN public.branches br ON br.id = i.branch_id
  WHERE i.branch_id IS NOT NULL AND br.business_id <> i.business_id;
$$;

REVOKE ALL ON FUNCTION public.verify_company_isolation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_company_isolation() TO authenticated;

COMMENT ON FUNCTION public.verify_company_isolation() IS
  'Read-only audit. Returns 0 rows when no cross-company contamination exists. Run periodically.';