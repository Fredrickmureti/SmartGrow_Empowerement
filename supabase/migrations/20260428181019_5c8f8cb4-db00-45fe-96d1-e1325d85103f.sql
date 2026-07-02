
-- =========================================================================
-- R1 — Drop the dangerous duplicate overload of provision_default_chart_of_accounts
-- =========================================================================
-- The varchar overload bypasses the is_country_neutral filter and the
-- statutory-keyword regex, silently re-opening the NHIF/SHIF/PAYE leak.
-- All callers in this repo pass upper(_country) which is text, so dropping
-- the varchar overload is safe.
DROP FUNCTION IF EXISTS public.provision_default_chart_of_accounts(uuid, uuid, character varying);

-- =========================================================================
-- R2 — Clean ZA template + extend regex + DB-level CHECK constraint
-- =========================================================================
DELETE FROM public.default_chart_of_accounts
WHERE account_name ~* '\m(sdl|wcf|skills\s*levy|gratuity\s*payable|epf|esic|provident\s*fund|pf\s*payable)\m';

-- Replace the text overload with an extended regex covering SDL, WCF, etc.
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid,
  _business_id uuid,
  _country_code text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1
  ) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country
      AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    INSERT INTO public.accounts (
      organization_id, business_id, code, name, account_type,
      parent_id, description, is_system, is_active
    ) VALUES (
      _org_id, _business_id, _template.account_code, _template.account_name,
      _template.account_type, _parent_id, _template.description,
      coalesce(_template.is_system, false), true
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO _new_id;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  RETURN _accounts_created;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.provision_default_chart_of_accounts(uuid, uuid, text) TO authenticated;

-- DB-level CHECK constraint: physically prevent statutory rows from being
-- inserted into the country-neutral template, regardless of who runs the seed.
ALTER TABLE public.default_chart_of_accounts
DROP CONSTRAINT IF EXISTS no_statutory_in_neutral_seed;

ALTER TABLE public.default_chart_of_accounts
ADD CONSTRAINT no_statutory_in_neutral_seed
CHECK (
  NOT (
    is_country_neutral = true
    AND account_name ~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
  )
);

-- =========================================================================
-- R3 — prevent_unmapped_system_role_delete trigger on default_account_settings
-- =========================================================================
-- Required system roles whose mapping must always exist for a business
-- once it has been mapped. Deleting the last mapping for any of these keys
-- is blocked at the DB level.
CREATE OR REPLACE FUNCTION public.prevent_unmapped_system_role_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _required_keys text[] := ARRAY[
    'cash','bank','accounts_receivable','accounts_payable',
    'sales_revenue','cost_of_goods_sold',
    'retained_earnings','opening_balance_equity',
    'output_tax','input_tax','inventory'
  ];
  _replacement_exists boolean;
BEGIN
  -- Only guard the canonical required roles
  IF NOT (OLD.setting_key = ANY(_required_keys)) THEN
    RETURN OLD;
  END IF;

  -- Is there ANOTHER mapping for the same role/scope after this delete?
  SELECT EXISTS (
    SELECT 1 FROM public.default_account_settings
     WHERE setting_key = OLD.setting_key
       AND business_id IS NOT DISTINCT FROM OLD.business_id
       AND organization_id IS NOT DISTINCT FROM OLD.organization_id
       AND id <> OLD.id
  ) INTO _replacement_exists;

  IF NOT _replacement_exists THEN
    RAISE EXCEPTION 'Cannot delete the only mapping for required system role "%". Map a replacement account first.', OLD.setting_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_unmapped_system_role_delete ON public.default_account_settings;
CREATE TRIGGER trg_prevent_unmapped_system_role_delete
BEFORE DELETE ON public.default_account_settings
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unmapped_system_role_delete();

-- =========================================================================
-- R4 — Reusable repair_legacy_statutory_accounts() function
-- =========================================================================
CREATE OR REPLACE FUNCTION public.repair_legacy_statutory_accounts(
  _organization_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _re text := '\m(nhif|paye|nssf|housing\s*levy|uif|sdl|wcf|epf|esic|provident\s*fund|pf\s*payable)\m';
  _legacy_suffix text := ' (legacy — install country localization pack)';
  _archived_no_postings integer := 0;
  _archived_with_postings integer := 0;
  _orgs_scanned integer := 0;
  _row record;
  _has_postings boolean;
BEGIN
  SELECT count(DISTINCT a.organization_id) INTO _orgs_scanned
    FROM public.accounts a
   WHERE a.name ~* _re
     AND (_organization_id IS NULL OR a.organization_id = _organization_id);

  FOR _row IN
    SELECT a.id, a.organization_id, a.business_id, a.name, a.is_active
      FROM public.accounts a
     WHERE a.name ~* _re
       AND (_organization_id IS NULL OR a.organization_id = _organization_id)
       AND a.name NOT LIKE '%(legacy — install country localization pack)%'
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.journal_entry_lines WHERE account_id = _row.id
    ) INTO _has_postings;

    IF _has_postings THEN
      UPDATE public.accounts
         SET is_active = false
       WHERE id = _row.id;
      _archived_with_postings := _archived_with_postings + 1;

      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type,
         old_value, new_value, reason)
      VALUES (_row.id, _row.organization_id, _row.business_id,
        'archive_legacy_statutory',
        jsonb_build_object('is_active', _row.is_active, 'name', _row.name),
        jsonb_build_object('is_active', false, 'name', _row.name),
        'Archived by repair_legacy_statutory_accounts (postings exist)');
    ELSE
      UPDATE public.accounts
         SET name = _row.name || _legacy_suffix,
             is_active = false
       WHERE id = _row.id;
      _archived_no_postings := _archived_no_postings + 1;

      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type,
         old_value, new_value, reason)
      VALUES (_row.id, _row.organization_id, _row.business_id,
        'archive_legacy_statutory',
        jsonb_build_object('is_active', _row.is_active, 'name', _row.name),
        jsonb_build_object('is_active', false, 'name', _row.name || _legacy_suffix),
        'Archived by repair_legacy_statutory_accounts (no postings)');
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'orgs_scanned', _orgs_scanned,
    'accounts_archived_no_postings', _archived_no_postings,
    'accounts_archived_with_postings', _archived_with_postings
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.repair_legacy_statutory_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_legacy_statutory_accounts(uuid) TO service_role;
