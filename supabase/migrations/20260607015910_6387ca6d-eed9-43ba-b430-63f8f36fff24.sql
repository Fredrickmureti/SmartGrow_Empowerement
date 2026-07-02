-- 1. Acknowledgement columns
ALTER TABLE public.employee_documents
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by UUID;

-- 2. SECURITY DEFINER RPC: employee acknowledges their own document.
--    Bypasses the lack of a column-restricted RLS UPDATE policy: we only
--    let an employee touch acknowledged_at/acknowledged_by, and only on
--    their own row. Idempotent — calling twice keeps the first timestamp.
CREATE OR REPLACE FUNCTION public.acknowledge_employee_document(_document_id UUID)
RETURNS public.employee_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _employee_id UUID;
  _doc public.employee_documents;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO _employee_id
  FROM public.employees
  WHERE user_id = auth.uid()
  LIMIT 1;

  IF _employee_id IS NULL THEN
    RAISE EXCEPTION 'no_employee_record_for_user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _doc
  FROM public.employee_documents
  WHERE id = _document_id;

  IF _doc.id IS NULL THEN
    RAISE EXCEPTION 'document_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF _doc.employee_id <> _employee_id THEN
    RAISE EXCEPTION 'cannot_acknowledge_other_employees_document' USING ERRCODE = '42501';
  END IF;

  IF _doc.acknowledged_at IS NOT NULL THEN
    RETURN _doc;
  END IF;

  UPDATE public.employee_documents
     SET acknowledged_at = now(),
         acknowledged_by = auth.uid(),
         updated_at = now()
   WHERE id = _document_id
   RETURNING * INTO _doc;

  RETURN _doc;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_employee_document(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_employee_document(UUID) TO authenticated;