CREATE OR REPLACE FUNCTION public.check_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  p_contact uuid;
  p_business uuid;
  p_org uuid;
  i_contact uuid;
  i_business uuid;
  i_org uuid;
BEGIN
  SELECT contact_id, business_id, organization_id
    INTO p_contact, p_business, p_org
    FROM public.payments
   WHERE id = NEW.payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation rejected: payment % was not found.', NEW.payment_id
      USING ERRCODE = '23503';
  END IF;

  SELECT contact_id, business_id, organization_id
    INTO i_contact, i_business, i_org
    FROM public.invoices
   WHERE id = NEW.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation rejected: invoice % was not found.', NEW.invoice_id
      USING ERRCODE = '23503';
  END IF;

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
END;
$function$;