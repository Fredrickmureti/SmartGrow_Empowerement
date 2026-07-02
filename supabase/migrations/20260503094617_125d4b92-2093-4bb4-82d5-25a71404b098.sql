-- ──────────────────────────────────────────────────────────────────────────
-- Sales module: defence-in-depth — branch must belong to the same business
-- as the row being inserted/updated. NULL branch_id is allowed (HQ context).
-- This complements client-side `applyBranchFilter` and atomic RPC validation.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.validate_branch_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_business_id uuid;
BEGIN
  -- HQ context: skip
  IF NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_branch_business_id
  FROM public.branches
  WHERE id = NEW.branch_id;

  IF v_branch_business_id IS NULL THEN
    RAISE EXCEPTION 'branch_id % does not exist', NEW.branch_id
      USING ERRCODE = '23503';
  END IF;

  IF v_branch_business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'branch_id % belongs to business %, not %',
      NEW.branch_id, v_branch_business_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Helper: install the trigger on a table only if branch_id+business_id columns
-- exist and the trigger isn't already in place.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'invoices',
    'estimates',
    'proforma_invoices',
    'sales_orders',
    'delivery_notes',
    'sales_returns',
    'recurring_invoices',
    'credit_notes',
    'payments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Skip if table missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=t
    ) THEN
      CONTINUE;
    END IF;

    -- Skip if branch_id or business_id columns missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=t AND column_name='branch_id'
    ) OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=t AND column_name='business_id'
    ) THEN
      CONTINUE;
    END IF;

    -- Drop and recreate to keep idempotent
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_branch_business_match ON public.%I;',
      t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%I_branch_business_match
         BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.validate_branch_business_match();',
      t, t
    );
  END LOOP;
END $$;