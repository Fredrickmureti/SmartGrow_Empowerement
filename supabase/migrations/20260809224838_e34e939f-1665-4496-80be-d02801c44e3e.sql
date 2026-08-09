ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_bill_to_contact_id_fkey;
ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_bill_to_contact_id_fkey;
ALTER TABLE public.estimates DROP CONSTRAINT IF EXISTS estimates_bill_to_contact_id_fkey;
ALTER TABLE public.proforma_invoices DROP CONSTRAINT IF EXISTS proforma_invoices_bill_to_contact_id_fkey;
ALTER TABLE public.bills DROP CONSTRAINT IF EXISTS bills_remit_to_contact_id_fkey;

-- Integrity without a PostgREST-visible second relationship to contacts:
-- the party must exist and share the document's business.
CREATE OR REPLACE FUNCTION public._assert_party_address_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
  v_business_id uuid;
BEGIN
  v_contact_id := CASE TG_TABLE_NAME
    WHEN 'bills' THEN NEW.remit_to_contact_id
    ELSE NEW.bill_to_contact_id
  END;

  IF v_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_business_id
  FROM public.contacts
  WHERE id = v_contact_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Address party % does not exist', v_contact_id
      USING ERRCODE = '23503';
  END IF;

  IF v_business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'Address party % belongs to a different business', v_contact_id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoices_bill_to_contact
  BEFORE INSERT OR UPDATE OF bill_to_contact_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._assert_party_address_contact();

CREATE TRIGGER trg_credit_notes_bill_to_contact
  BEFORE INSERT OR UPDATE OF bill_to_contact_id ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._assert_party_address_contact();

CREATE TRIGGER trg_estimates_bill_to_contact
  BEFORE INSERT OR UPDATE OF bill_to_contact_id ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public._assert_party_address_contact();

CREATE TRIGGER trg_proforma_invoices_bill_to_contact
  BEFORE INSERT OR UPDATE OF bill_to_contact_id ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public._assert_party_address_contact();

CREATE TRIGGER trg_bills_remit_to_contact
  BEFORE INSERT OR UPDATE OF remit_to_contact_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._assert_party_address_contact();