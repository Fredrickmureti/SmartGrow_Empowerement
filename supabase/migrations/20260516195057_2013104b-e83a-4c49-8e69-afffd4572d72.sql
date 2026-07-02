CREATE OR REPLACE FUNCTION public.list_org_storage_paths(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_receipts text[];
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  SELECT coalesce(
           array_agg(DISTINCT receipt_url)
             FILTER (WHERE receipt_url IS NOT NULL AND receipt_url <> ''),
           ARRAY[]::text[]
         )
    INTO v_receipts
  FROM public.expenses
  WHERE organization_id = org_id;

  -- No `documents` table exists in this schema; per-bucket folder sweeps
  -- in the edge function handle artifact cleanup wholesale via the
  -- `<org_id>/` prefix. We only need to surface explicit, externally
  -- referenced paths (currently: expense receipts).
  RETURN jsonb_build_object(
    'receipts',                  v_receipts,
    'document_pdfs',             ARRAY[]::text[],
    'documents',                 ARRAY[]::text[],
    'employee_documents',        ARRAY[]::text[],
    'employee_avatars',          ARRAY[]::text[],
    'organization_assets',       ARRAY[]::text[],
    'product_images',            ARRAY[]::text[],
    'sign_documents',            ARRAY[]::text[],
    'signatures',                ARRAY[]::text[],
    'custom_field_attachments',  ARRAY[]::text[],
    'folder_prefix',             org_id::text || '/'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_org_storage_paths(uuid) TO authenticated;