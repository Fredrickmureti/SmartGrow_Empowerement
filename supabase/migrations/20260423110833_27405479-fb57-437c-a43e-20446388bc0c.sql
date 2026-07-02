CREATE OR REPLACE FUNCTION public.enforce_sales_order_delete_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Cannot delete sales order % with status %. Only draft orders can be deleted.',
      OLD.so_number, OLD.status;
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lock_sales_order_on_invoice_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.converted_invoice_id IS NOT NULL
     AND (OLD.converted_invoice_id IS NULL OR OLD.converted_invoice_id <> NEW.converted_invoice_id) THEN
    NEW.is_locked := true;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_sales_order_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.is_locked = true THEN
    IF NEW.subtotal <> OLD.subtotal
       OR NEW.tax_amount <> OLD.tax_amount
       OR NEW.discount_amount <> OLD.discount_amount
       OR NEW.shipping_amount <> OLD.shipping_amount
       OR NEW.total <> OLD.total
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'Sales order % is locked (already invoiced). Cannot modify financial fields.',
        OLD.so_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;