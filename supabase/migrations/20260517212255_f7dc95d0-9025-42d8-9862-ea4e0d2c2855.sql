
-- =========================================================================
-- ADR 0012 — P1a (GL primitive correction + invariant hardening)
-- =========================================================================

-- 1. Seed canonical "customer_deposits" mapping for every business -------
-- Re-uses the project's existing primitive (liability account, NetSuite
-- "Customer Deposit" semantics) instead of inventing a parallel
-- "outstanding_receipts" asset.
DO $$
DECLARE
  b RECORD;
  v_account_id uuid;
BEGIN
  FOR b IN
    SELECT bz.id AS business_id, bz.organization_id
    FROM public.businesses bz
    WHERE NOT EXISTS (
      SELECT 1 FROM public.default_account_settings das
      WHERE das.business_id = bz.id
        AND das.setting_key = 'customer_deposits'
    )
  LOOP
    -- Reuse existing Customer Deposits account if one is already on the COA.
    SELECT id INTO v_account_id
    FROM public.accounts
    WHERE business_id = b.business_id
      AND detail_type = 'customer_deposits'
      AND is_active = true
    ORDER BY code
    LIMIT 1;

    IF v_account_id IS NULL THEN
      INSERT INTO public.accounts (
        organization_id, business_id, account_type, code, name,
        description, detail_type, is_system, is_active
      ) VALUES (
        b.organization_id, b.business_id, 'liability', '2210-1',
        'Customer Deposits',
        'Unapplied customer cash and advances. Holds money received that has not yet been applied to an invoice (ADR 0012).',
        'customer_deposits', true, true
      )
      RETURNING id INTO v_account_id;
    END IF;

    INSERT INTO public.default_account_settings (
      organization_id, business_id, setting_key, account_id
    ) VALUES (
      b.organization_id, b.business_id, 'customer_deposits', v_account_id
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END$$;

-- 2. invoice_id-flip safety trigger ---------------------------------------
-- Without this, app code can `UPDATE payments SET invoice_id = ...` and
-- silently break the outstanding+applied=amount invariant. This trigger
-- recomputes the split whenever invoice_id changes, before the existing
-- enforce_payment_amount_split trigger validates it.
CREATE OR REPLACE FUNCTION public.recompute_payment_split_on_invoice_flip()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only act when invoice_id actually changes and status is not voided.
  IF NEW.status = 'voided' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    IF NEW.invoice_id IS NULL THEN
      -- Detached from invoice → becomes outstanding (advance / unapplied).
      NEW.outstanding_amount := NEW.amount;
      NEW.applied_amount     := 0;
    ELSE
      -- Newly attached → fully applied (single-invoice model; per-invoice
      -- splits will be modelled by a future payment_applications table).
      NEW.outstanding_amount := 0;
      NEW.applied_amount     := NEW.amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_payment_split_on_invoice_flip ON public.payments;
CREATE TRIGGER trg_recompute_payment_split_on_invoice_flip
BEFORE UPDATE OF invoice_id ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.recompute_payment_split_on_invoice_flip();

-- 3. Idempotency key on reversal events -----------------------------------
ALTER TABLE public.payment_reversal_events
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reversal_events_idem
  ON public.payment_reversal_events(payment_id, op, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- 4. Closed-period guard helper -------------------------------------------
-- Safe default: if no fiscal-period table exists for the project, the helper
-- returns TRUE (period is open). When a fiscal_periods / accounting_periods
-- table is added later, replace the body to check it. Reversal RPCs must
-- still call this so the policy lights up automatically when periods land.
CREATE OR REPLACE FUNCTION public.is_period_open(
  _business_id uuid,
  _post_date date
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_table boolean;
  is_open boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('fiscal_periods','accounting_periods')
  ) INTO has_table;

  IF NOT has_table THEN
    RETURN true; -- No period model yet → permissive default.
  END IF;

  -- Defensive: try the most likely table first, fall back to permissive.
  BEGIN
    EXECUTE format(
      'SELECT NOT EXISTS (
         SELECT 1 FROM public.%I
         WHERE business_id = $1
           AND $2 BETWEEN start_date AND end_date
           AND COALESCE(is_closed, false) = true
       )',
      CASE
        WHEN to_regclass('public.fiscal_periods') IS NOT NULL THEN 'fiscal_periods'
        ELSE 'accounting_periods'
      END
    )
    USING _business_id, _post_date
    INTO is_open;
  EXCEPTION WHEN others THEN
    RETURN true;
  END;

  RETURN COALESCE(is_open, true);
END;
$$;

REVOKE ALL ON FUNCTION public.is_period_open(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.is_period_open(uuid, date) TO authenticated;
