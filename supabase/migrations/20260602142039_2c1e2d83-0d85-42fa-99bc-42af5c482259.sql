-- ADR 0028: Allocation-first vendor payments (AP mirror of ADR 0027)
-- Creates bill_payment_allocations as the canonical link between
-- bill_payments and bills, mirroring payment_allocations on AR.
-- The legacy bill_payments.bill_id FK is kept for backward compatibility;
-- a trigger auto-creates a backfill allocation row from it so the
-- canonical surface (allocations) is always populated. Column DROP is
-- deferred to a follow-up migration once all readers are repointed.

-- 1. Allocations table
CREATE TABLE IF NOT EXISTS public.bill_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_payment_id UUID NOT NULL REFERENCES public.bill_payments(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.bills(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  organization_id UUID,
  business_id UUID,
  branch_id UUID,
  source TEXT NOT NULL DEFAULT 'rpc' CHECK (source IN ('rpc','backfill','reallocation','legacy_fk')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_payment_allocations_bp ON public.bill_payment_allocations(bill_payment_id);
CREATE INDEX IF NOT EXISTS idx_bill_payment_allocations_bill ON public.bill_payment_allocations(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_payment_allocations_org_business ON public.bill_payment_allocations(organization_id, business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_payment_allocations TO authenticated;
GRANT ALL ON public.bill_payment_allocations TO service_role;

ALTER TABLE public.bill_payment_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_payment_allocations_select" ON public.bill_payment_allocations
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.bill_payments bp
            WHERE bp.id = bill_payment_id
              AND public.user_has_module_permission(auth.uid(), bp.organization_id, 'purchases', 'read'))
  );

CREATE POLICY "bill_payment_allocations_insert" ON public.bill_payment_allocations
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.bill_payments bp
            WHERE bp.id = bill_payment_id
              AND public.user_has_module_permission(auth.uid(), bp.organization_id, 'purchases', 'write'))
  );

CREATE POLICY "bill_payment_allocations_update" ON public.bill_payment_allocations
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.bill_payments bp
            WHERE bp.id = bill_payment_id
              AND public.user_has_module_permission(auth.uid(), bp.organization_id, 'purchases', 'write'))
  );

CREATE POLICY "bill_payment_allocations_delete" ON public.bill_payment_allocations
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.bill_payments bp
            WHERE bp.id = bill_payment_id
              AND public.user_has_module_permission(auth.uid(), bp.organization_id, 'purchases', 'delete'))
  );

-- 2. Consistency trigger: allocation's bill must share vendor + business + org
--    with the parent bill_payment, and inherit scope from the parent.
CREATE OR REPLACE FUNCTION public.check_bill_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  bp_vendor uuid; bp_business uuid; bp_org uuid; bp_branch uuid;
  bl_vendor uuid; bl_business uuid; bl_org uuid;
BEGIN
  SELECT bp.organization_id, bp.business_id, bp.branch_id, b.vendor_id
    INTO bp_org, bp_business, bp_branch, bp_vendor
    FROM public.bill_payments bp
    LEFT JOIN public.bills b ON b.id = bp.bill_id
    WHERE bp.id = NEW.bill_payment_id;
  SELECT vendor_id, business_id, organization_id
    INTO bl_vendor, bl_business, bl_org
    FROM public.bills WHERE id = NEW.bill_id;

  IF bl_org IS DISTINCT FROM bp_org THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different workspaces.'
      USING ERRCODE = '23514';
  END IF;
  IF bl_business IS DISTINCT FROM bp_business THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different companies.'
      USING ERRCODE = '23514';
  END IF;
  -- Vendor: when the legacy FK is set we already enforced; for new allocations
  -- the parent payment may have a NULL bp_vendor (multi-bill case). In that
  -- case, accept the first allocation's vendor and require subsequent allocations
  -- on the same payment to match.
  IF bp_vendor IS NOT NULL AND bp_vendor IS DISTINCT FROM bl_vendor THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: vendor mismatch.'
      USING ERRCODE = '23514';
  END IF;

  -- Stamp scope from parent payment.
  NEW.organization_id := bp_org;
  NEW.business_id     := bp_business;
  NEW.branch_id       := COALESCE(NEW.branch_id, bp_branch);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payment_alloc_consistency ON public.bill_payment_allocations;
CREATE TRIGGER trg_bill_payment_alloc_consistency
  BEFORE INSERT OR UPDATE ON public.bill_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.check_bill_payment_allocation_consistency();

-- 3. Deferred sum-invariant: sum(allocations) <= bill_payments.amount (+0.005)
CREATE OR REPLACE FUNCTION public.check_bill_payment_allocation_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_bpid uuid;
  v_sum numeric;
  v_amount numeric;
BEGIN
  v_bpid := COALESCE(NEW.bill_payment_id, OLD.bill_payment_id);
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.bill_payment_allocations WHERE bill_payment_id = v_bpid;
  SELECT COALESCE(amount, 0) INTO v_amount
    FROM public.bill_payments WHERE id = v_bpid;
  IF v_sum > v_amount + 0.005 THEN
    RAISE EXCEPTION 'Bill payment % allocation sum % exceeds payment amount %.',
      v_bpid, v_sum, v_amount
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payment_alloc_sum_invariant ON public.bill_payment_allocations;
CREATE CONSTRAINT TRIGGER trg_bill_payment_alloc_sum_invariant
  AFTER INSERT OR UPDATE OR DELETE ON public.bill_payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_bill_payment_allocation_sum();

-- 4. Period-closure guard on bill_payments (mirror AR)
CREATE OR REPLACE FUNCTION public.check_bill_payment_period_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.business_id IS NOT NULL
     AND NEW.payment_date IS NOT NULL
     AND NOT public.is_period_open(NEW.business_id, NEW.payment_date) THEN
    RAISE EXCEPTION 'Bill payment date % falls in a closed fiscal period.', NEW.payment_date
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payment_period_open ON public.bill_payments;
CREATE TRIGGER trg_bill_payment_period_open
  BEFORE INSERT ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public.check_bill_payment_period_open();

-- 5. AFTER INSERT trigger on bill_payments: if a legacy bill_id-only payment
--    is inserted (no allocation row created by the caller), auto-write one
--    so the canonical surface (allocations) is always populated going
--    forward. RPCs that already write allocations explicitly are unaffected.
CREATE OR REPLACE FUNCTION public.auto_create_bill_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.bill_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only fire if no allocation has been created by an explicit caller.
  IF EXISTS (SELECT 1 FROM public.bill_payment_allocations
             WHERE bill_payment_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.bill_payment_allocations
    (bill_payment_id, bill_id, amount, organization_id, business_id, branch_id, source, created_by)
  VALUES
    (NEW.id, NEW.bill_id, NEW.amount, NEW.organization_id, NEW.business_id, NEW.branch_id, 'legacy_fk', NEW.created_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_bill_payment_allocation ON public.bill_payments;
CREATE TRIGGER trg_auto_bill_payment_allocation
  AFTER INSERT ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public.auto_create_bill_payment_allocation();

-- 6. Backfill: one allocation row per existing bill_payment using its bill_id
INSERT INTO public.bill_payment_allocations
  (bill_payment_id, bill_id, amount, organization_id, business_id, branch_id, source, created_at)
SELECT bp.id, bp.bill_id, COALESCE(bp.amount, 0), bp.organization_id, bp.business_id, bp.branch_id,
       'backfill', COALESCE(bp.created_at, now())
  FROM public.bill_payments bp
 WHERE bp.bill_id IS NOT NULL
   AND COALESCE(bp.amount, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM public.bill_payment_allocations a WHERE a.bill_payment_id = bp.id);

-- 7. Multi-bill payment RPC (mirror record_multi_invoice_payment).
--    Writes ONE bill_payments header (bill_id = NULL) and N allocation rows,
--    posts ONE JE: Dr AP (sum) / Cr Bank (total).
CREATE OR REPLACE FUNCTION public.record_multi_bill_payment(
  _org_id uuid,
  _business_id uuid,
  _vendor_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _bank_account_id uuid DEFAULT NULL,
  _payable_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bp_id UUID;
  v_je_id UUID;
  v_je_number TEXT;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_alloc RECORD;
  v_bill RECORD;
  v_sum_allocated NUMERIC := 0;
  v_new_amount_paid NUMERIC;
  v_new_status TEXT;
  v_bill_statuses JSONB := '[]'::jsonb;
  v_vendor_name TEXT;
BEGIN
  IF _bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Bank/cash account is required for multi-bill payment.';
  END IF;
  IF _payable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Payable account is required.';
  END IF;
  IF _total_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive.';
  END IF;

  SELECT name INTO v_vendor_name FROM contacts
    WHERE id = _vendor_id AND organization_id = _org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vendor not found'; END IF;

  -- ONE bill_payments header. bill_id=NULL so the auto-trigger doesn't fire;
  -- we'll write the allocations explicitly below.
  INSERT INTO public.bill_payments
    (organization_id, business_id, bill_id, bank_account_id, payment_date,
     amount, payment_method, reference, notes, created_by, branch_id)
  VALUES
    (_org_id, _business_id, NULL, _bank_account_id, _payment_date,
     _total_amount, _payment_method, _reference, _notes, _created_by, _branch_id)
  RETURNING id INTO v_bp_id;

  FOR v_alloc IN SELECT * FROM jsonb_to_recordset(_allocations) AS x(bill_id uuid, amount numeric)
  LOOP
    IF v_alloc.amount <= 0 THEN CONTINUE; END IF;

    SELECT id, bill_number, total, amount_paid, vendor_id
      INTO v_bill
      FROM public.bills
     WHERE id = v_alloc.bill_id AND organization_id = _org_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bill % not found', v_alloc.bill_id;
    END IF;
    IF v_bill.vendor_id IS DISTINCT FROM _vendor_id THEN
      RAISE EXCEPTION 'Bill % does not belong to vendor %', v_alloc.bill_id, _vendor_id;
    END IF;

    INSERT INTO public.bill_payment_allocations
      (bill_payment_id, bill_id, amount, source, created_by)
    VALUES
      (v_bp_id, v_alloc.bill_id, v_alloc.amount, 'rpc', _created_by);

    v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + v_alloc.amount;
    IF v_new_amount_paid >= v_bill.total THEN v_new_status := 'paid';
    ELSE v_new_status := 'partial';
    END IF;

    UPDATE public.bills
       SET amount_paid = v_new_amount_paid,
           status = v_new_status::bill_status
     WHERE id = v_alloc.bill_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;
    v_bill_statuses := v_bill_statuses || jsonb_build_object(
      'bill_id', v_alloc.bill_id, 'new_status', v_new_status,
      'new_amount_paid', v_new_amount_paid);
  END LOOP;

  -- ONE journal entry: Dr AP (sum) / Cr Bank (total). Excess (sum < total)
  -- is parked against AP for now; vendor credit handling deferred.
  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id);
      INSERT INTO public.journal_entries
        (organization_id, business_id, entry_number, entry_date,
         reference, description, source_type, source_id, status, created_by, branch_id)
      VALUES
        (_org_id, _business_id, v_je_number, _payment_date,
         'BPMT-' || v_bp_id::text,
         'Bill payment to ' || v_vendor_name,
         'bill_payment', v_bp_id, 'posted', _created_by, _branch_id)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
      END IF;
    END;
  END LOOP;

  IF v_sum_allocated > 0 THEN
    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
    VALUES (v_je_id, _payable_account_id, v_sum_allocated, 0,
            'AP reduction - ' || v_vendor_name, _branch_id);
  END IF;
  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id)
  VALUES (v_je_id, _bank_account_id, 0, _total_amount,
          'Bill payment to ' || v_vendor_name, _branch_id);

  UPDATE public.bill_payments SET journal_entry_id = v_je_id WHERE id = v_bp_id;

  RETURN jsonb_build_object(
    'bill_payment_id', v_bp_id,
    'journal_entry_id', v_je_id,
    'sum_allocated', v_sum_allocated,
    'excess_amount', _total_amount - v_sum_allocated,
    'bill_statuses', v_bill_statuses
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_multi_bill_payment(
  uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid
) TO authenticated;

-- 8. Vendor ledger view (AP mirror of customer_ledger_entries).
DROP VIEW IF EXISTS public.vendor_ledger_entries;
CREATE VIEW public.vendor_ledger_entries
WITH (security_invoker = true)
AS
  SELECT
    b.organization_id,
    b.business_id,
    b.branch_id,
    b.vendor_id          AS contact_id,
    b.bill_date          AS entry_date,
    'bill'::text         AS doc_type,
    b.id                 AS doc_id,
    b.bill_number        AS doc_ref,
    0::numeric           AS debit,
    COALESCE(b.total, 0) AS credit,
    b.currency,
    b.created_at
  FROM public.bills b
  WHERE b.status::text NOT IN ('void','draft')

  UNION ALL

  SELECT
    bp.organization_id,
    bp.business_id,
    COALESCE(a.branch_id, bp.branch_id),
    b.vendor_id          AS contact_id,
    bp.payment_date      AS entry_date,
    'bill_payment'::text AS doc_type,
    bp.id                AS doc_id,
    COALESCE(bp.reference, bp.id::text) AS doc_ref,
    a.amount             AS debit,
    0::numeric           AS credit,
    b.currency,
    a.created_at
  FROM public.bill_payment_allocations a
  JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
  JOIN public.bills b ON b.id = a.bill_id

  UNION ALL

  SELECT
    vcn.organization_id,
    vcn.business_id,
    vcn.branch_id,
    vcn.vendor_id        AS contact_id,
    vcn.credit_date      AS entry_date,
    'vendor_credit_note'::text AS doc_type,
    vcn.id               AS doc_id,
    vcn.credit_note_number AS doc_ref,
    COALESCE(vcn.total, 0) AS debit,
    0::numeric           AS credit,
    vcn.currency,
    vcn.created_at
  FROM public.vendor_credit_notes vcn
  WHERE vcn.status NOT IN ('void','draft');

GRANT SELECT ON public.vendor_ledger_entries TO authenticated;
GRANT SELECT ON public.vendor_ledger_entries TO service_role;

COMMENT ON VIEW public.vendor_ledger_entries IS
  'Canonical chronological vendor ledger (ADR 0028). '
  'Single source of truth for vendor statements, AP balance, and aging. '
  'Allocation-first: bill payment debits come from bill_payment_allocations.';