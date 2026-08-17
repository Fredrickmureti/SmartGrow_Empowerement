-- Phase 4 (cycle count governance wave): count paperwork must supersede itself
-- when the underlying resolution changes, instead of silently mutating a frozen
-- snapshot in place.

CREATE OR REPLACE FUNCTION public._document_snapshot_fingerprint(p_snapshot jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_snapshot IS NULL THEN NULL
    ELSE md5(
      (p_snapshot
        - 'generated_at' - 'printed_at' - 'rendered_at' - 'requested_by'
        - 'requested_at' - 'now' - 'as_of')::text
    )
  END
$$;

COMMENT ON FUNCTION public._document_snapshot_fingerprint(jsonb) IS
  'Stable content fingerprint of a document snapshot, ignoring volatile render-time keys.';

CREATE OR REPLACE FUNCTION public.ensure_document_record(
  p_kind_code text, p_organization_id uuid, p_source_module text,
  p_source_doc_type text, p_source_doc_id uuid, p_business_id uuid DEFAULT NULL::uuid,
  p_branch_id uuid DEFAULT NULL::uuid, p_party_kind text DEFAULT NULL::text,
  p_party_id uuid DEFAULT NULL::uuid, p_currency text DEFAULT NULL::text,
  p_locale text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb,
  p_document_number text DEFAULT NULL::text, p_document_date date DEFAULT NULL::date,
  p_snapshot jsonb DEFAULT NULL::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id           uuid;
  v_old          public.document_records%ROWTYPE;
  v_old_fp       text;
  v_new_fp       text;
  v_supersedable boolean;
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

  SELECT * INTO v_old
  FROM public.document_records
  WHERE organization_id = p_organization_id
    AND source_module   = p_source_module
    AND source_doc_type = p_source_doc_type
    AND source_doc_id   = p_source_doc_id
    AND superseded_by IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_old.id IS NOT NULL THEN
    -- Cycle count paperwork is versioned: once the count's resolution changes,
    -- the frozen artifact is no longer the truth. Reprints of the old version
    -- stay retrievable via superseded_by.
    v_supersedable := p_kind_code LIKE 'wms.count_%';
    v_old_fp := public._document_snapshot_fingerprint(v_old.snapshot);
    v_new_fp := public._document_snapshot_fingerprint(p_snapshot);

    IF v_supersedable AND p_snapshot IS NOT NULL
       AND v_old_fp IS DISTINCT FROM v_new_fp THEN
      INSERT INTO public.document_records (
        organization_id, business_id, branch_id, kind_code, version,
        source_module, source_doc_type, source_doc_id,
        party_kind, party_id, currency, locale, metadata, created_by,
        document_number, document_date, snapshot
      ) VALUES (
        p_organization_id,
        COALESCE(p_business_id, v_old.business_id),
        COALESCE(p_branch_id, v_old.branch_id),
        p_kind_code,
        COALESCE(v_old.version, 1) + 1,
        p_source_module, p_source_doc_type, p_source_doc_id,
        COALESCE(p_party_kind, v_old.party_kind),
        COALESCE(p_party_id, v_old.party_id),
        COALESCE(p_currency, v_old.currency),
        COALESCE(p_locale, v_old.locale),
        COALESCE(v_old.metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
        auth.uid(),
        COALESCE(p_document_number, v_old.document_number),
        COALESCE(p_document_date, v_old.document_date),
        p_snapshot
      )
      RETURNING id INTO v_id;

      UPDATE public.document_records
         SET superseded_by = v_id,
             status        = 'superseded',
             updated_at    = now()
       WHERE id = v_old.id;

      RETURN v_id;
    END IF;

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
     WHERE id = v_old.id;
    RETURN v_old.id;
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
$function$;