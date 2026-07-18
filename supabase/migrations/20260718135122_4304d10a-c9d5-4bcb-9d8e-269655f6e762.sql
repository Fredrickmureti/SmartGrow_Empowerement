
-- Batch N-Constraints — DB-level cross-table integrity triggers
-- (PURCHASES_AUDIT §7 P3). Fires on future writes; live DB already clean.

CREATE OR REPLACE FUNCTION public.enforce_branch_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_business uuid;
BEGIN
  IF NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO v_branch_business FROM public.branches WHERE id = NEW.branch_id;
  IF v_branch_business IS NULL THEN
    RAISE EXCEPTION 'branch % not found', NEW.branch_id USING ERRCODE = '23514';
  END IF;
  IF v_branch_business <> NEW.business_id THEN
    RAISE EXCEPTION 'branch % belongs to business %, not %', NEW.branch_id, v_branch_business, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_bill_po_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_business uuid;
BEGIN
  IF NEW.purchase_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO v_po_business FROM public.purchase_orders WHERE id = NEW.purchase_order_id;
  IF v_po_business IS NULL THEN
    RAISE EXCEPTION 'purchase order % not found', NEW.purchase_order_id USING ERRCODE = '23514';
  END IF;
  IF v_po_business <> NEW.business_id THEN
    RAISE EXCEPTION 'purchase order % belongs to business %, not %', NEW.purchase_order_id, v_po_business, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_vcn_application_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vcn_business uuid;
  v_bill_business uuid;
BEGIN
  SELECT business_id INTO v_vcn_business FROM public.vendor_credit_notes WHERE id = NEW.credit_note_id;
  SELECT business_id INTO v_bill_business FROM public.bills WHERE id = NEW.bill_id;
  IF v_vcn_business IS NULL OR v_bill_business IS NULL THEN
    RAISE EXCEPTION 'credit note or bill not found (vcn=%, bill=%)', NEW.credit_note_id, NEW.bill_id
      USING ERRCODE = '23514';
  END IF;
  IF v_vcn_business <> v_bill_business THEN
    RAISE EXCEPTION 'vendor credit note business % does not match bill business %', v_vcn_business, v_bill_business
      USING ERRCODE = '23514';
  END IF;
  IF NEW.business_id IS NOT NULL AND NEW.business_id <> v_vcn_business THEN
    RAISE EXCEPTION 'application.business_id % does not match credit note business %', NEW.business_id, v_vcn_business
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Attach branch-vs-business triggers.
DROP TRIGGER IF EXISTS trg_bills_branch_business ON public.bills;
CREATE TRIGGER trg_bills_branch_business
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_purchase_orders_branch_business ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_branch_business
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_vendor_credit_notes_branch_business ON public.vendor_credit_notes;
CREATE TRIGGER trg_vendor_credit_notes_branch_business
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_bill_payments_branch_business ON public.bill_payments;
CREATE TRIGGER trg_bill_payments_branch_business
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.bill_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_journal_entries_branch_business ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_branch_business
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- Bill ↔ PO business equality.
DROP TRIGGER IF EXISTS trg_bills_po_business ON public.bills;
CREATE TRIGGER trg_bills_po_business
  BEFORE INSERT OR UPDATE OF purchase_order_id, business_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bill_po_business_match();

-- VCN application ↔ VCN ↔ Bill business equality.
DROP TRIGGER IF EXISTS trg_vcn_applications_business ON public.vendor_credit_note_applications;
CREATE TRIGGER trg_vcn_applications_business
  BEFORE INSERT OR UPDATE OF credit_note_id, bill_id, business_id ON public.vendor_credit_note_applications
  FOR EACH ROW EXECUTE FUNCTION public.enforce_vcn_application_business_match();
