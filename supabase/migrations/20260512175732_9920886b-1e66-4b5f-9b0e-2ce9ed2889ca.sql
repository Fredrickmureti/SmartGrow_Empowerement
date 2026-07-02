CREATE OR REPLACE FUNCTION public.trg_invoice_lines_repost_revenue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  v_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  -- Touch the parent invoice so its AFTER UPDATE triggers (incl. trg_invoices_revenue)
  -- re-run with the new line totals. Do NOT call trigger functions directly here —
  -- PostgreSQL forbids invoking a function that returns `trigger` outside a trigger context.
  UPDATE public.invoices SET updated_at = now() WHERE id = v_id;
  RETURN COALESCE(NEW, OLD);
END; $function$;