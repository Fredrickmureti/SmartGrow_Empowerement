-- 1. Migrate the last legacy pin to intent-based routing.
UPDATE public.document_print_policies
SET intent = COALESCE(intent, 'receipt'),
    printer_profile_id = NULL
WHERE printer_profile_id IS NOT NULL
  AND device_assignment_id IS NULL;

UPDATE public.document_print_policies
SET printer_profile_id = NULL
WHERE printer_profile_id IS NOT NULL;

ALTER TABLE public.document_print_policies
  DROP CONSTRAINT IF EXISTS document_print_policies_printer_profile_id_fkey;
ALTER TABLE public.document_print_policies
  DROP COLUMN IF EXISTS printer_profile_id;

-- 2. print_jobs: the pin is a device_assignments row, not a legacy profile.
ALTER TABLE public.print_jobs
  RENAME COLUMN printer_profile_id TO device_assignment_id;

-- 3. Canonical resolver returns the device assignment pin.
DROP FUNCTION IF EXISTS public.print_policies_resolve(uuid, uuid, text, text);
CREATE FUNCTION public.print_policies_resolve(
  p_business_id uuid,
  p_branch_id uuid,
  p_document_type text,
  p_intent text DEFAULT NULL::text
)
RETURNS TABLE(device_assignment_id uuid, paper_format text, render_mode text, copies integer, auto_print boolean, ask_user boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH ranked AS (
    SELECT
      dpp.device_assignment_id,
      dpp.paper_format,
      dpp.render_mode,
      dpp.auto_print,
      dpp.copies,
      CASE
        WHEN dpp.branch_id IS NOT DISTINCT FROM p_branch_id
             AND dpp.intent IS NOT DISTINCT FROM p_intent THEN 1
        WHEN dpp.branch_id IS NOT DISTINCT FROM p_branch_id
             AND dpp.intent IS NULL                       THEN 2
        WHEN dpp.branch_id IS NULL
             AND dpp.intent IS NOT DISTINCT FROM p_intent THEN 3
        WHEN dpp.branch_id IS NULL
             AND dpp.intent IS NULL                       THEN 4
        ELSE 99
      END AS specificity
    FROM public.document_print_policies dpp
    WHERE dpp.business_id   = p_business_id
      AND dpp.document_type = p_document_type
      AND (dpp.branch_id IS NULL OR dpp.branch_id = p_branch_id)
      AND (dpp.intent    IS NULL OR dpp.intent    = p_intent)
  ),
  picked AS (
    SELECT * FROM ranked WHERE specificity < 99 ORDER BY specificity ASC LIMIT 1
  )
  SELECT
    picked.device_assignment_id,
    COALESCE(picked.paper_format, 'a4')   AS paper_format,
    COALESCE(picked.render_mode, 'pdf')   AS render_mode,
    COALESCE(picked.copies, 1)            AS copies,
    COALESCE(picked.auto_print, false)    AS auto_print,
    false                                 AS ask_user
  FROM picked
  UNION ALL
  SELECT NULL::uuid, 'a4', 'pdf', 1, false, true
  WHERE NOT EXISTS (SELECT 1 FROM picked)
  LIMIT 1;
$function$;

-- 4. Ledger insert takes the device assignment pin.
DROP FUNCTION IF EXISTS public.print_job_insert(uuid, uuid, text, uuid, text, text, uuid, uuid, text, text, uuid);
CREATE FUNCTION public.print_job_insert(
  p_business_id uuid,
  p_branch_id uuid,
  p_doc_type text,
  p_doc_id uuid,
  p_intent text,
  p_format text,
  p_device_assignment_id uuid,
  p_media_profile_id uuid,
  p_correlation_id text,
  p_transport text,
  p_parent_job_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'print_job_insert: caller has no access to business %', p_business_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.print_jobs (
    business_id, branch_id, doc_type, doc_id, intent, format,
    device_assignment_id, media_profile_id, correlation_id, transport,
    parent_job_id, requested_by, status, attempt_count
  ) VALUES (
    p_business_id, p_branch_id, p_doc_type, p_doc_id, p_intent, p_format,
    p_device_assignment_id, p_media_profile_id, p_correlation_id, p_transport,
    p_parent_job_id, auth.uid(), 'queued', 1
  )
  ON CONFLICT (business_id, correlation_id) DO UPDATE
    SET attempt_count = public.print_jobs.attempt_count + 1,
        updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.print_job_insert(uuid, uuid, text, uuid, text, text, uuid, uuid, text, text, uuid) TO authenticated, service_role;

-- 5. Drop the legacy registry surfaces.
DROP TABLE IF EXISTS public.printer_workflow_bindings;
DROP TABLE IF EXISTS public.printer_profiles;

ALTER TABLE public.device_assignments DROP COLUMN IF EXISTS source_config_id;