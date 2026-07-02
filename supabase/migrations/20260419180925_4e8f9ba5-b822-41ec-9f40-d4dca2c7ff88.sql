
-- ── Step 2: Backfill businesses from organizations ──────────────────────────
UPDATE public.businesses b
SET
  legal_name    = COALESCE(NULLIF(b.legal_name, ''),    o.name),
  tax_id        = COALESCE(NULLIF(b.tax_id, ''),        o.tax_id),
  logo_url      = COALESCE(NULLIF(b.logo_url, ''),      o.logo_url),
  address       = COALESCE(NULLIF(b.address, ''),       o.address),
  city          = COALESCE(NULLIF(b.city, ''),          o.city),
  state         = COALESCE(NULLIF(b.state, ''),         o.state),
  postal_code   = COALESCE(NULLIF(b.postal_code, ''),   o.postal_code),
  country       = COALESCE(NULLIF(b.country, ''),       o.country),
  email         = COALESCE(NULLIF(b.email, ''),         o.email),
  phone         = COALESCE(NULLIF(b.phone, ''),         o.phone),
  website       = COALESCE(NULLIF(b.website, ''),       o.website),
  base_currency = COALESCE(NULLIF(b.base_currency, ''), o.base_currency, 'USD')
FROM public.organizations o
WHERE b.organization_id = o.id;

-- ── Step 3 (DB part): mark org identity columns deprecated ──────────────────
COMMENT ON COLUMN public.organizations.tax_id        IS 'DEPRECATED — read from businesses.tax_id';
COMMENT ON COLUMN public.organizations.logo_url      IS 'DEPRECATED for documents — read from businesses.logo_url. Org logo retained only for tenant/account-switcher avatar.';
COMMENT ON COLUMN public.organizations.base_currency IS 'DEPRECATED — read from businesses.base_currency. Org no longer authoritative for accounting currency.';
COMMENT ON COLUMN public.organizations.address       IS 'DEPRECATED — read from businesses.address';
COMMENT ON COLUMN public.organizations.city          IS 'DEPRECATED — read from businesses.city';
COMMENT ON COLUMN public.organizations.state         IS 'DEPRECATED — read from businesses.state';
COMMENT ON COLUMN public.organizations.postal_code   IS 'DEPRECATED — read from businesses.postal_code';
COMMENT ON COLUMN public.organizations.country       IS 'DEPRECATED — read from businesses.country';
COMMENT ON COLUMN public.organizations.email         IS 'DEPRECATED for documents — read from businesses.email. Org email retained for billing.';
COMMENT ON COLUMN public.organizations.phone         IS 'DEPRECATED — read from businesses.phone';
COMMENT ON COLUMN public.organizations.website       IS 'DEPRECATED — read from businesses.website';

-- ── Step 1b: branches.organization_id must match businesses.organization_id ─
CREATE OR REPLACE FUNCTION public.enforce_branch_org_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_org uuid;
BEGIN
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;
  SELECT organization_id INTO v_business_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_business_org IS NULL THEN
    RAISE EXCEPTION 'branches.business_id % does not exist', NEW.business_id;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_business_org THEN
    RAISE EXCEPTION 'branches.organization_id (%) must match businesses.organization_id (%)',
      NEW.organization_id, v_business_org;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_branch_org_consistency ON public.branches;
CREATE TRIGGER trg_enforce_branch_org_consistency
BEFORE INSERT OR UPDATE OF organization_id, business_id ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_org_consistency();

-- ── Step 4: lock business.base_currency once any JE exists ──────────────────
CREATE OR REPLACE FUNCTION public.enforce_business_currency_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_count int;
BEGIN
  IF NEW.base_currency IS NOT DISTINCT FROM OLD.base_currency THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO v_je_count FROM public.journal_entries WHERE business_id = NEW.id LIMIT 1;
  IF v_je_count > 0 THEN
    RAISE EXCEPTION 'business.base_currency is immutable once journal entries exist (business_id=%, je_count=%). Old=%, attempted=%',
      NEW.id, v_je_count, OLD.base_currency, NEW.base_currency
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_currency_immutable ON public.businesses;
CREATE TRIGGER trg_business_currency_immutable
BEFORE UPDATE OF base_currency ON public.businesses
FOR EACH ROW EXECUTE FUNCTION public.enforce_business_currency_immutable();

-- ── Step 1a: journal_entries.business_id must align with org ────────────────
CREATE OR REPLACE FUNCTION public.enforce_je_business_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_org uuid;
BEGIN
  IF NEW.business_id IS NULL THEN RETURN NEW; END IF;
  SELECT organization_id INTO v_business_org FROM public.businesses WHERE id = NEW.business_id;
  IF v_business_org IS NULL THEN
    RAISE EXCEPTION 'journal_entries.business_id % does not exist', NEW.business_id;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_business_org THEN
    RAISE EXCEPTION 'journal_entries.organization_id (%) must match businesses.organization_id (%) for business_id %',
      NEW.organization_id, v_business_org, NEW.business_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_business_org_match ON public.journal_entries;
CREATE TRIGGER trg_je_business_org_match
BEFORE INSERT OR UPDATE OF organization_id, business_id ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_je_business_org_match();

-- ── Step 5: server-side business-access guard inside posting RPC ────────────
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  _org_id uuid, _business_id uuid, _entry_number text, _entry_date date,
  _reference text, _description text, _source_type text, _source_id uuid,
  _created_by uuid, _is_closing boolean, _is_adjusting boolean, _lines jsonb,
  _currency text DEFAULT NULL::text, _exchange_rate numeric DEFAULT NULL::numeric,
  _source_subtype text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry_id uuid;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_existing_id uuid;
  v_idx int := 0;
  v_fiscal_period_id uuid;
  v_line_debit numeric;
  v_line_credit numeric;
  v_is_org_admin boolean;
  v_has_business_access boolean;
BEGIN
  -- Authorization: org admins bypass; others need explicit business access
  IF _created_by IS NOT NULL AND _business_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _created_by
        AND organization_id = _org_id
        AND role IN ('super_admin','owner','admin')
    ) INTO v_is_org_admin;

    IF NOT COALESCE(v_is_org_admin, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.user_business_access
        WHERE user_id = _created_by
          AND organization_id = _org_id
          AND business_id = _business_id
      ) INTO v_has_business_access;

      IF NOT COALESCE(v_has_business_access, false) THEN
        RAISE EXCEPTION 'User % is not authorized to post to business % in organization %',
          _created_by, _business_id, _org_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- Idempotency
  IF _source_type IS NOT NULL AND _source_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.journal_entries
    WHERE organization_id = _org_id
      AND source_type = _source_type
      AND source_id = _source_id
      AND COALESCE(source_subtype, 'main') = COALESCE(_source_subtype, 'main')
      AND status <> 'voided'
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF _lines IS NULL OR jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'Journal entry requires at least 2 lines';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_total_debit  := v_total_debit  + COALESCE((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry not balanced: debit=% credit=%', v_total_debit, v_total_credit;
  END IF;

  BEGIN
    SELECT id INTO v_fiscal_period_id
    FROM public.fiscal_periods
    WHERE organization_id = _org_id
      AND _entry_date BETWEEN start_date AND end_date
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_fiscal_period_id := NULL;
  END;

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, reference, description,
    source_type, source_id, source_subtype, created_by,
    is_closing_entry, is_adjusting_entry,
    is_closing, is_adjusting,
    status,
    total_debit, total_credit, posted_at, posted_by,
    currency, exchange_rate, fiscal_period_id
  ) VALUES (
    _org_id, _business_id, _entry_number, _entry_date, _reference, _description,
    _source_type, _source_id, _source_subtype, _created_by,
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false),
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false),
    'posted',
    v_total_debit, v_total_credit, now(), _created_by,
    _currency, _exchange_rate, v_fiscal_period_id
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_line_debit  := COALESCE((v_line->>'debit')::numeric, 0);
    v_line_credit := COALESCE((v_line->>'credit')::numeric, 0);

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      contact_id, analytic_account_id, exchange_rate, sort_order,
      original_currency, original_debit, original_credit
    ) VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      v_line_debit,
      v_line_credit,
      v_line->>'description',
      NULLIF(v_line->>'contact_id','')::uuid,
      NULLIF(v_line->>'analytic_account_id','')::uuid,
      COALESCE(NULLIF(v_line->>'exchange_rate','')::numeric, _exchange_rate),
      COALESCE((v_line->>'sort_order')::int, v_idx),
      _currency,
      CASE WHEN _currency IS NOT NULL THEN v_line_debit  ELSE NULL END,
      CASE WHEN _currency IS NOT NULL THEN v_line_credit ELSE NULL END
    );
    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_entry_id;
END;
$function$;
