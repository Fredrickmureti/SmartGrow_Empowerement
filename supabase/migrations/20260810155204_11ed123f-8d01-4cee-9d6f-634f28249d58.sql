-- Bill review states (used by later migrations / app code)
ALTER TYPE public.bill_status ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE public.bill_status ADD VALUE IF NOT EXISTS 'approved';

-- Per-company AP control policy
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS require_bill_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_duplicate_vendor_invoice_numbers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_bill_approval_on_match_exception boolean NOT NULL DEFAULT true;

-- Lookup index for supplier-scoped invoice numbers
CREATE INDEX IF NOT EXISTS idx_bills_vendor_invoice_number
  ON public.bills (organization_id, vendor_id, upper(btrim(vendor_invoice_number)))
  WHERE vendor_invoice_number IS NOT NULL AND btrim(vendor_invoice_number) <> '';

-- Duplicate supplier invoice guard (policy-aware, so it cannot be a unique index)
CREATE OR REPLACE FUNCTION public.enforce_unique_vendor_invoice_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean;
  v_existing text;
BEGIN
  IF NEW.vendor_invoice_number IS NULL
     OR btrim(NEW.vendor_invoice_number) = ''
     OR NEW.vendor_id IS NULL
     OR NEW.status = 'void'::bill_status THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.vendor_invoice_number IS NOT DISTINCT FROM NEW.vendor_invoice_number
     AND OLD.vendor_id IS NOT DISTINCT FROM NEW.vendor_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(b.allow_duplicate_vendor_invoice_numbers, false)
    INTO v_allowed
    FROM public.businesses b
   WHERE b.id = NEW.business_id;

  IF COALESCE(v_allowed, false) THEN
    RETURN NEW;
  END IF;

  SELECT b.bill_number INTO v_existing
    FROM public.bills b
   WHERE b.organization_id = NEW.organization_id
     AND b.vendor_id = NEW.vendor_id
     AND b.id <> NEW.id
     AND b.status <> 'void'::bill_status
     AND b.vendor_invoice_number IS NOT NULL
     AND upper(btrim(b.vendor_invoice_number)) = upper(btrim(NEW.vendor_invoice_number))
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION
      'Duplicate supplier invoice: this vendor invoice number is already recorded on bill %. Void that bill or enable duplicate supplier invoice numbers for this company.',
      v_existing
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_unique_vendor_invoice_number ON public.bills;
CREATE TRIGGER trg_bills_unique_vendor_invoice_number
  BEFORE INSERT OR UPDATE OF vendor_invoice_number, vendor_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_unique_vendor_invoice_number();

-- Pre-submit soft check for the bill form
CREATE OR REPLACE FUNCTION public.find_duplicate_vendor_invoice(
  _org_id uuid,
  _vendor_id uuid,
  _vendor_invoice_number text,
  _exclude_bill_id uuid DEFAULT NULL
)
RETURNS TABLE (
  bill_id uuid,
  bill_number text,
  bill_date date,
  total numeric,
  status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT b.id, b.bill_number, b.bill_date, b.total, b.status::text
    FROM public.bills b
   WHERE b.organization_id = _org_id
     AND b.vendor_id = _vendor_id
     AND b.status <> 'void'::bill_status
     AND (_exclude_bill_id IS NULL OR b.id <> _exclude_bill_id)
     AND _vendor_invoice_number IS NOT NULL
     AND btrim(_vendor_invoice_number) <> ''
     AND b.vendor_invoice_number IS NOT NULL
     AND upper(btrim(b.vendor_invoice_number)) = upper(btrim(_vendor_invoice_number))
   ORDER BY b.bill_date DESC
   LIMIT 5;
$$;

GRANT EXECUTE ON FUNCTION public.find_duplicate_vendor_invoice(uuid, uuid, text, uuid) TO authenticated;