-- =========================================================================
-- ADR 0012 — Payment reversal intent model (corrected: uses user_roles
-- as the membership table; this project does not have user_organizations).
-- =========================================================================

-- 1. Intent enum -----------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_reversal_reason') THEN
    CREATE TYPE public.payment_reversal_reason AS ENUM (
      'data_entry_error',
      'duplicate_payment',
      'bank_transfer_failed',
      'wrong_invoice_applied',
      'customer_refund_requested',
      'invoice_cancelled_keep_as_credit',
      'invoice_cancelled_keep_as_advance'
    );
  END IF;
END$$;

-- 2. Outstanding / applied split on payments -------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS outstanding_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS applied_amount     numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversal_reason    public.payment_reversal_reason;

UPDATE public.payments
SET
  applied_amount =
    CASE
      WHEN status = 'voided' THEN 0
      WHEN invoice_id IS NOT NULL THEN amount
      ELSE 0
    END,
  outstanding_amount =
    CASE
      WHEN status = 'voided' THEN 0
      WHEN invoice_id IS NULL THEN amount
      ELSE 0
    END
WHERE applied_amount = 0 AND outstanding_amount = 0;

CREATE OR REPLACE FUNCTION public.enforce_payment_amount_split()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'voided' THEN
    NEW.outstanding_amount := 0;
    NEW.applied_amount := 0;
    RETURN NEW;
  END IF;

  NEW.outstanding_amount := COALESCE(NEW.outstanding_amount, 0);
  NEW.applied_amount     := COALESCE(NEW.applied_amount, 0);

  IF ABS((NEW.outstanding_amount + NEW.applied_amount) - NEW.amount) > 0.005 THEN
    RAISE EXCEPTION
      'payments invariant violated: amount=% outstanding=% applied=% (sum=%)',
      NEW.amount, NEW.outstanding_amount, NEW.applied_amount,
      NEW.outstanding_amount + NEW.applied_amount
    USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_amount_split ON public.payments;
CREATE TRIGGER trg_enforce_payment_amount_split
BEFORE INSERT OR UPDATE OF amount, outstanding_amount, applied_amount, status
ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_payment_amount_split();

-- 3. Append-only reversal-event log ---------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_reversal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  op text NOT NULL CHECK (op IN ('void','unapply','refund','reapply','credit_note')),
  reason_code public.payment_reversal_reason,
  reason_text text,
  amount_before_outstanding numeric,
  amount_before_applied numeric,
  amount_after_outstanding numeric,
  amount_after_applied numeric,
  reversal_journal_entry_id uuid,
  credit_note_id uuid,
  customer_refund_id uuid,
  performed_by uuid,
  performed_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE INDEX IF NOT EXISTS idx_payment_reversal_events_payment
  ON public.payment_reversal_events(payment_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_reversal_events_org
  ON public.payment_reversal_events(organization_id, business_id, performed_at DESC);

ALTER TABLE public.payment_reversal_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read reversal events in their org" ON public.payment_reversal_events;
CREATE POLICY "Members can read reversal events in their org"
ON public.payment_reversal_events
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = payment_reversal_events.organization_id
      AND ur.is_active = true
  )
);

-- No INSERT / UPDATE / DELETE policy: writes happen only through SECURITY
-- DEFINER server functions / RPC (single source of truth = useTransactionReversal).

-- 4. Customer refunds -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  contact_id uuid NOT NULL,
  source_payment_id uuid REFERENCES public.payments(id) ON DELETE RESTRICT,
  source_credit_note_id uuid REFERENCES public.credit_notes(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KES',
  refund_date date NOT NULL DEFAULT CURRENT_DATE,
  bank_account_id uuid NOT NULL,
  payment_method text,
  reference text,
  reason text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','voided')),
  journal_entry_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  CONSTRAINT customer_refund_source_xor CHECK (
    (source_payment_id IS NOT NULL)::int + (source_credit_note_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_customer_refunds_contact
  ON public.customer_refunds(contact_id, refund_date DESC);
CREATE INDEX IF NOT EXISTS idx_customer_refunds_org_business
  ON public.customer_refunds(organization_id, business_id, refund_date DESC);
CREATE INDEX IF NOT EXISTS idx_customer_refunds_source_payment
  ON public.customer_refunds(source_payment_id) WHERE source_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_refunds_source_credit_note
  ON public.customer_refunds(source_credit_note_id) WHERE source_credit_note_id IS NOT NULL;

ALTER TABLE public.customer_refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read customer refunds" ON public.customer_refunds;
CREATE POLICY "Members can read customer refunds"
ON public.customer_refunds
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = customer_refunds.organization_id
      AND ur.is_active = true
  )
);

DROP POLICY IF EXISTS "Org admins can insert customer refunds" ON public.customer_refunds;
CREATE POLICY "Org admins can insert customer refunds"
ON public.customer_refunds
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = customer_refunds.organization_id
      AND ur.is_active = true
      AND ur.role::text IN ('owner','admin')
  )
);

DROP POLICY IF EXISTS "Org admins can update customer refunds" ON public.customer_refunds;
CREATE POLICY "Org admins can update customer refunds"
ON public.customer_refunds
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = customer_refunds.organization_id
      AND ur.is_active = true
      AND ur.role::text IN ('owner','admin')
  )
);

-- 5. Outstanding-receipts default-accounts purpose ------------------------
COMMENT ON COLUMN public.default_accounts.purpose IS
  'Canonical purpose key. Includes ''outstanding_receipts'' (current asset) introduced by ADR 0012 for unapplied customer cash.';