ALTER TABLE public.document_records
  ADD COLUMN IF NOT EXISTS document_number text,
  ADD COLUMN IF NOT EXISTS document_date   date,
  ADD COLUMN IF NOT EXISTS snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS document_records_org_number_idx
  ON public.document_records (organization_id, document_number)
  WHERE document_number IS NOT NULL;

-- Extend the ensure_document_record helper to accept + upsert these fields.
CREATE OR REPLACE FUNCTION public.ensure_document_record(
  p_kind_code       text,
  p_organization_id uuid,
  p_source_module   text,
  p_source_doc_type text,
  p_source_doc_id   uuid,
  p_business_id     uuid  DEFAULT NULL,
  p_branch_id       uuid  DEFAULT NULL,
  p_party_kind      text  DEFAULT NULL,
  p_party_id        uuid  DEFAULT NULL,
  p_currency        text  DEFAULT NULL,
  p_locale          text  DEFAULT NULL,
  p_metadata        jsonb DEFAULT '{}'::jsonb,
  p_document_number text  DEFAULT NULL,
  p_document_date   date  DEFAULT NULL,
  p_snapshot        jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required' USING ERRCODE = '22004';
  END IF;
  IF p_kind_code IS NULL OR p_source_module IS NULL
     OR p_source_doc_type IS NULL OR p_source_doc_id IS NULL THEN
    RAISE EXCEPTION 'kind_code and source triple are required' USING ERRCODE = '22004';
  END IF;

  PERFORM public._assert_org_member(p_organization_id);

  IF NOT EXISTS (SELECT 1 FROM public.document_kinds WHERE code = p_kind_code AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive document kind: %', p_kind_code USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_id
  FROM public.document_records
  WHERE organization_id = p_organization_id
    AND source_module   = p_source_module
    AND source_doc_type = p_source_doc_type
    AND source_doc_id   = p_source_doc_id
    AND superseded_by IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    UPDATE public.document_records
       SET metadata        = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           party_kind      = COALESCE(party_kind, p_party_kind),
           party_id        = COALESCE(party_id, p_party_id),
           currency        = COALESCE(currency, p_currency),
           locale          = COALESCE(locale, p_locale),
           business_id     = COALESCE(business_id, p_business_id),
           branch_id       = COALESCE(branch_id, p_branch_id),
           document_number = COALESCE(p_document_number, document_number),
           document_date   = COALESCE(p_document_date, document_date),
           snapshot        = COALESCE(p_snapshot, snapshot),
           updated_at      = now()
     WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.document_records (
    organization_id, business_id, branch_id, kind_code,
    source_module, source_doc_type, source_doc_id,
    party_kind, party_id, currency, locale, metadata, created_by,
    document_number, document_date, snapshot
  ) VALUES (
    p_organization_id, p_business_id, p_branch_id, p_kind_code,
    p_source_module, p_source_doc_type, p_source_doc_id,
    p_party_kind, p_party_id, p_currency, p_locale,
    COALESCE(p_metadata, '{}'::jsonb), auth.uid(),
    p_document_number, p_document_date, COALESCE(p_snapshot, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) TO service_role;

-- Drop the older 12-arg overload so callers can't mistakenly bypass snapshot columns.
DROP FUNCTION IF EXISTS public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb);
