
-- M-1 (retry) — enum-correct values: invoices use 'voided'/'cancelled',
-- credit_notes use 'void', payments.status is text ('completed' / 'voided' / 'unreconciled').

ALTER TABLE public.payment_allocations
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'rpc';

ALTER TABLE public.payment_allocations
  DROP CONSTRAINT IF EXISTS payment_allocations_source_check;
ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_source_check
  CHECK (source IN ('rpc','backfill','reallocation'));

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment_id
  ON public.payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice_id
  ON public.payment_allocations(invoice_id);

DROP TRIGGER IF EXISTS trg_cascade_branch_payment_allocations
  ON public.payment_allocations;

-- Backfill
INSERT INTO public.payment_allocations
  (payment_id, invoice_id, amount, branch_id, source, created_at)
SELECT p.id,
       p.invoice_id,
       COALESCE(p.applied_amount, p.amount, 0),
       p.branch_id,
       'backfill',
       COALESCE(p.created_at, now())
  FROM public.payments p
 WHERE p.invoice_id IS NOT NULL
   AND COALESCE(p.applied_amount, p.amount, 0) > 0
   AND COALESCE(p.status, 'completed') NOT IN ('voided','cancelled')
   AND NOT EXISTS (
     SELECT 1 FROM public.payment_allocations a
      WHERE a.payment_id = p.id
   );

-- Consistency: alloc must share customer + business with payment
CREATE OR REPLACE FUNCTION public.check_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  p_contact uuid; p_business uuid; p_org uuid;
  i_contact uuid; i_business uuid; i_org uuid;
BEGIN
  SELECT contact_id, business_id, organization_id
    INTO p_contact, p_business, p_org
    FROM public.payments WHERE id = NEW.payment_id;
  SELECT contact_id, business_id, organization_id
    INTO i_contact, i_business, i_org
    FROM public.invoices WHERE id = NEW.invoice_id;

  IF p_contact IS DISTINCT FROM i_contact THEN
    RAISE EXCEPTION 'Allocation rejected: payment customer % does not match invoice customer %.', p_contact, i_contact
      USING ERRCODE = '23514';
  END IF;
  IF p_business IS DISTINCT FROM i_business THEN
    RAISE EXCEPTION 'Allocation rejected: payment and invoice belong to different companies.'
      USING ERRCODE = '23514';
  END IF;
  IF p_org IS DISTINCT FROM i_org THEN
    RAISE EXCEPTION 'Allocation rejected: payment and invoice belong to different workspaces.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_alloc_consistency ON public.payment_allocations;
CREATE TRIGGER trg_payment_alloc_consistency
  BEFORE INSERT OR UPDATE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_allocation_consistency();

-- Deferred sum-invariant
CREATE OR REPLACE FUNCTION public.check_payment_allocation_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_pid uuid;
  v_sum numeric;
  v_applied numeric;
  v_status text;
BEGIN
  v_pid := COALESCE(NEW.payment_id, OLD.payment_id);
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.payment_allocations WHERE payment_id = v_pid;
  SELECT COALESCE(applied_amount, 0), COALESCE(status, 'completed')
    INTO v_applied, v_status
    FROM public.payments WHERE id = v_pid;
  IF v_status IN ('voided','cancelled','unreconciled') THEN
    RETURN NULL;
  END IF;
  IF ABS(v_sum - v_applied) > 0.005 THEN
    RAISE EXCEPTION 'Payment % allocation sum % does not match applied amount %.',
      v_pid, v_sum, v_applied
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_payment_alloc_sum_invariant ON public.payment_allocations;
CREATE CONSTRAINT TRIGGER trg_payment_alloc_sum_invariant
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_allocation_sum();

-- Period-closure guard on payments INSERT
CREATE OR REPLACE FUNCTION public.check_payment_period_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.business_id IS NOT NULL
     AND NEW.payment_date IS NOT NULL
     AND NOT public.is_period_open(NEW.business_id, NEW.payment_date) THEN
    RAISE EXCEPTION 'Payment date % falls in a closed fiscal period. Pick a date in an open period.', NEW.payment_date
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_period_open ON public.payments;
CREATE TRIGGER trg_payment_period_open
  BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_period_open();

-- Canonical customer ledger view
DROP VIEW IF EXISTS public.customer_ledger_entries;
CREATE VIEW public.customer_ledger_entries AS
  SELECT
    i.organization_id,
    i.business_id,
    i.branch_id,
    i.contact_id,
    i.issue_date              AS entry_date,
    'invoice'::text           AS doc_type,
    i.id                      AS doc_id,
    i.invoice_number          AS doc_ref,
    COALESCE(i.total, 0)      AS debit,
    0::numeric                AS credit,
    i.currency,
    i.created_at
  FROM public.invoices i
  WHERE i.status::text NOT IN ('voided','cancelled','draft')

  UNION ALL

  SELECT
    p.organization_id,
    p.business_id,
    COALESCE(a.branch_id, p.branch_id),
    p.contact_id,
    p.payment_date            AS entry_date,
    'payment'::text           AS doc_type,
    p.id                      AS doc_id,
    COALESCE(p.receipt_number, p.id::text) AS doc_ref,
    0::numeric                AS debit,
    a.amount                  AS credit,
    i.currency,
    a.created_at
  FROM public.payment_allocations a
  JOIN public.payments p ON p.id = a.payment_id
  JOIN public.invoices  i ON i.id = a.invoice_id
  WHERE COALESCE(p.status, 'completed') NOT IN ('voided','cancelled')

  UNION ALL

  -- Unapplied (deposit) portion of a payment.
  SELECT
    p.organization_id,
    p.business_id,
    p.branch_id,
    p.contact_id,
    p.payment_date            AS entry_date,
    'deposit'::text           AS doc_type,
    p.id                      AS doc_id,
    COALESCE(p.receipt_number, p.id::text) AS doc_ref,
    0::numeric                AS debit,
    COALESCE(p.outstanding_amount, 0) AS credit,
    NULL::text                AS currency,
    p.created_at
  FROM public.payments p
  WHERE COALESCE(p.outstanding_amount, 0) > 0
    AND COALESCE(p.status, 'completed') NOT IN ('voided','cancelled')

  UNION ALL

  SELECT
    cn.organization_id,
    cn.business_id,
    cn.branch_id,
    cn.contact_id,
    cn.issue_date             AS entry_date,
    'credit_note'::text       AS doc_type,
    cn.id                     AS doc_id,
    cn.credit_note_number     AS doc_ref,
    0::numeric                AS debit,
    COALESCE(cn.total, 0)     AS credit,
    cn.currency,
    cn.created_at
  FROM public.credit_notes cn
  WHERE cn.status::text NOT IN ('void','draft')

  UNION ALL

  SELECT
    r.organization_id,
    r.business_id,
    r.branch_id,
    r.contact_id,
    r.refund_date             AS entry_date,
    'refund'::text            AS doc_type,
    r.id                      AS doc_id,
    COALESCE(r.reference, r.id::text) AS doc_ref,
    COALESCE(r.amount, 0)     AS debit,
    0::numeric                AS credit,
    r.currency,
    r.created_at
  FROM public.customer_refunds r
  WHERE COALESCE(r.status, 'completed') NOT IN ('voided','cancelled');

GRANT SELECT ON public.customer_ledger_entries TO authenticated;
GRANT SELECT ON public.customer_ledger_entries TO service_role;

COMMENT ON VIEW public.customer_ledger_entries IS
  'Canonical chronological customer ledger (ADR 0027). '
  'Single source of truth for customer statements, balance, and aging. '
  'Allocation-first: payment credits come from payment_allocations, '
  'not from payments.invoice_id.';
