CREATE OR REPLACE FUNCTION public.tg_invoice_fiscal_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Compare via ::text so obsolete labels ('issued','approved','finalized') left
  -- over from earlier enum revisions cannot break inserts by failing enum cast.
  IF NEW.status::text IN ('sent','paid','confirmed')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NULL, NEW.branch_id,
      'invoices', NEW.id, 'invoice',
      jsonb_build_object('total', NEW.total, 'invoice_number', NEW.invoice_number)
    );
  END IF;
  RETURN NEW;
END;
$$;