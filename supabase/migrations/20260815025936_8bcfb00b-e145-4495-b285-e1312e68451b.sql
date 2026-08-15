CREATE OR REPLACE FUNCTION public.resolve_sales_line_tax(
  p_business_id    uuid,
  p_product_id     uuid,
  p_contact_id     uuid,
  p_date           date DEFAULT CURRENT_DATE,
  p_tax_rate_id    uuid DEFAULT NULL,
  p_requested_rate numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_date     date := COALESCE(p_date, CURRENT_DATE);
  v_tr       public.tax_rates%ROWTYPE;
  v_res      jsonb;
  v_rate     numeric;
  v_match    uuid;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false,
                              'fixed_amount', 0, 'tax_type', NULL, 'source', 'none');
  END IF;

  -- (1) An explicitly chosen rate must be this company's, active and in force.
  IF p_tax_rate_id IS NOT NULL THEN
    SELECT * INTO v_tr
      FROM public.tax_rates tr
     WHERE tr.id = p_tax_rate_id
       AND tr.business_id = p_business_id
       AND COALESCE(tr.is_active, true)
       AND (tr.effective_from IS NULL OR tr.effective_from <= v_date)
       AND (tr.effective_to   IS NULL OR tr.effective_to   >= v_date);
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'tax rate % is not an active rate for this company on %', p_tax_rate_id, v_date
        USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_tr.is_compound, false) THEN
      RAISE EXCEPTION
        'compound tax rate % is not supported on a sales line (one tax per line)', p_tax_rate_id
        USING ERRCODE = '0A000';
    END IF;
    RETURN jsonb_build_object(
      'rate', COALESCE(v_tr.rate, 0), 'tax_rate_id', v_tr.id,
      'is_inclusive', COALESCE(v_tr.is_inclusive, false),
      'fixed_amount', COALESCE(v_tr.fixed_amount, 0),
      'tax_type', v_tr.tax_type, 'source', 'line_override');
  END IF;

  -- (2) Product lines, and "what would this customer be taxed?" previews
  --     (product NULL and no rate typed): the canonical cascade
  --     exemption > customer default > product > company default.
  IF p_product_id IS NOT NULL OR p_requested_rate IS NULL THEN
    v_res := public.resolve_line_tax_rate(p_business_id, p_product_id, p_contact_id, v_date);
    IF NULLIF(v_res->>'tax_rate_id','') IS NOT NULL THEN
      SELECT * INTO v_tr FROM public.tax_rates tr WHERE tr.id = (v_res->>'tax_rate_id')::uuid;
      IF FOUND AND COALESCE(v_tr.is_compound, false) THEN
        RAISE EXCEPTION
          'compound tax rate % is not supported on a sales line (one tax per line)', v_tr.id
          USING ERRCODE = '0A000';
      END IF;
      RETURN v_res || jsonb_build_object('fixed_amount', COALESCE(v_tr.fixed_amount, 0),
                                         'tax_type', v_tr.tax_type);
    END IF;
    RETURN v_res || jsonb_build_object('fixed_amount', 0, 'tax_type', NULL);
  END IF;

  -- (3) Free-text lines: a typed rate must correspond to a live company rate.
  v_rate := COALESCE(p_requested_rate, 0);
  IF v_rate = 0 THEN
    RETURN jsonb_build_object('rate', 0, 'tax_rate_id', NULL, 'is_inclusive', false,
                              'fixed_amount', 0, 'tax_type', NULL, 'source', 'none');
  END IF;

  SELECT tr.id INTO v_match
    FROM public.tax_rates tr
   WHERE tr.business_id = p_business_id
     AND COALESCE(tr.is_active, true)
     AND NOT COALESCE(tr.is_compound, false)
     AND tr.rate = v_rate
     AND (tr.effective_from IS NULL OR tr.effective_from <= v_date)
     AND (tr.effective_to   IS NULL OR tr.effective_to   >= v_date)
   ORDER BY tr.effective_from DESC NULLS LAST
   LIMIT 1;

  IF v_match IS NULL THEN
    RAISE EXCEPTION
      'tax rate % percent is not configured for this company on %', v_rate, v_date
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tr FROM public.tax_rates tr WHERE tr.id = v_match;
  RETURN jsonb_build_object(
    'rate', COALESCE(v_tr.rate, 0), 'tax_rate_id', v_tr.id,
    'is_inclusive', COALESCE(v_tr.is_inclusive, false),
    'fixed_amount', COALESCE(v_tr.fixed_amount, 0),
    'tax_type', v_tr.tax_type, 'source', 'free_text_validated');
END;
$function$;