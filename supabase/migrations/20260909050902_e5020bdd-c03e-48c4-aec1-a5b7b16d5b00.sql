CREATE OR REPLACE FUNCTION public.reset_module__unlink_audit_refs(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  -- Legacy ERP link columns (invoice references on M-Pesa/timesheet rows) do
  -- not exist in the microfinance schema. Unlink only what is present.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='mpesa_c2b_transactions'
                AND column_name='matched_invoice_id') THEN
    EXECUTE 'UPDATE public.mpesa_c2b_transactions SET matched_invoice_id = NULL
              WHERE organization_id = $1 AND matched_invoice_id IS NOT NULL' USING org_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v := v || jsonb_build_object('mpesa_c2b_transactions_unlinked', n);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='timesheets'
                AND column_name='invoice_id') THEN
    EXECUTE 'UPDATE public.timesheets SET invoice_id = NULL
              WHERE organization_id = $1 AND invoice_id IS NOT NULL' USING org_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v := v || jsonb_build_object('timesheets_unlinked', n);
  END IF;

  RETURN v;
END;
$fn$;