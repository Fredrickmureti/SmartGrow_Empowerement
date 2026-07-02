
-- ============================================================================
-- COA OVERHAUL — Phase A + B
-- Country-neutral defaults, statutory accounts move to localization packs,
-- existing data repaired, system-account protection enforced in DB.
-- ============================================================================

-- ------------------------------------------------------------------
-- 0. Audit log table (used by Phase B trigger and by repair below)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_change_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid,                     -- nullable: account may have been deleted
  organization_id uuid,
  business_id uuid,
  change_type text NOT NULL,           -- 'rename' | 'recode' | 'type_change' | 'archive' | 'restore' | 'delete' | 'system_repair'
  old_value jsonb,
  new_value jsonb,
  reason text,
  changed_by uuid,                     -- auth.uid() when available
  changed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_change_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read account audit log for their org"
  ON public.account_change_audit_log FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

-- Service role / SECURITY DEFINER functions write to it; no INSERT policy for end users.

CREATE INDEX IF NOT EXISTS idx_account_change_audit_account ON public.account_change_audit_log(account_id);
CREATE INDEX IF NOT EXISTS idx_account_change_audit_business ON public.account_change_audit_log(business_id, changed_at DESC);

-- ------------------------------------------------------------------
-- 1. Mark every default_chart_of_accounts row as country-neutral or not,
--    then PURGE statutory rows from the global seed (they belong in
--    localization packs only).
-- ------------------------------------------------------------------
ALTER TABLE public.default_chart_of_accounts
  ADD COLUMN IF NOT EXISTS is_country_neutral boolean NOT NULL DEFAULT true;

DELETE FROM public.default_chart_of_accounts
WHERE account_name ~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|epf|provident\s*fund|esic|pf\s*payable)\m';

-- Forbid future statutory accounts from being added to the global seed.
-- They MUST live in localization_pack_account_templates.
ALTER TABLE public.default_chart_of_accounts
  DROP CONSTRAINT IF EXISTS default_coa_no_statutory;
ALTER TABLE public.default_chart_of_accounts
  ADD CONSTRAINT default_coa_no_statutory
  CHECK (account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|epf|provident\s*fund|esic|pf\s*payable)\m');

-- ------------------------------------------------------------------
-- 2. Rewrite provision_default_chart_of_accounts:
--    - Always seed the country-neutral subset of the country template
--      (or fall back to INT if no template exists for the country).
--    - Refuse to seed any row that smells statutory (defence in depth).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid,
  _business_id uuid,
  _country_code text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  -- Fall back to INT if no template exists for the requested country.
  IF NOT EXISTS (
    SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1
  ) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country
      AND is_country_neutral = true              -- country-neutral subset only
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|epf|provident\s*fund|esic|pf\s*payable)\m'
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
$$;

GRANT EXECUTE ON FUNCTION public.provision_default_chart_of_accounts(uuid, uuid, text) TO authenticated;

-- ------------------------------------------------------------------
-- 3. Repair existing organizations
--    Strategy:
--      a) drop bogus default_account_settings rows pointing at statutory
--         accounts (e.g. customer_deposits → NHIF Payable in test data)
--      b) for statutory accounts with NO postings: archive + rename to
--         "<name> (legacy — install country localization pack)"
--      c) for statutory accounts WITH postings: leave intact for history
--         but archive (is_active=false) so they vanish from new pickers
-- ------------------------------------------------------------------
DO $repair$
DECLARE
  _r record;
  _has_postings boolean;
  _new_name text;
BEGIN
  -- (a) Remove obviously-wrong default mappings to statutory accounts.
  --     A statutory liability should never be the customer-deposit account etc.
  FOR _r IN
    SELECT d.id, d.setting_key, d.account_id, a.name
    FROM public.default_account_settings d
    JOIN public.accounts a ON a.id = d.account_id
    WHERE a.name ~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif)\m'
      AND d.setting_key NOT IN (
        'paye_payable','nssf_payable','shif_payable','housing_levy_payable',
        'employer_nssf_expense','employer_shif_expense','employer_housing_levy_expense'
      )
  LOOP
    INSERT INTO public.account_change_audit_log
      (account_id, change_type, old_value, reason)
    VALUES (
      _r.account_id, 'system_repair',
      jsonb_build_object('setting_key', _r.setting_key, 'account_name', _r.name),
      'Removed bogus default_account_settings mapping to statutory account during COA overhaul'
    );
    DELETE FROM public.default_account_settings WHERE id = _r.id;
  END LOOP;

  -- (b)+(c) Process statutory accounts left in the wild.
  FOR _r IN
    SELECT a.id, a.organization_id, a.business_id, a.code, a.name, a.is_active
    FROM public.accounts a
    WHERE a.name ~* '\m(nhif|paye|nssf|housing\s*levy|uif)\m'
      AND a.name !~* '\mshif\m'              -- leave SHIF (current Kenya statutory) alone
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = _r.id) INTO _has_postings;

    IF _has_postings THEN
      -- Has postings: archive only, keep name for historical reporting.
      IF _r.is_active THEN
        UPDATE public.accounts SET is_active = false WHERE id = _r.id;
        INSERT INTO public.account_change_audit_log
          (account_id, organization_id, business_id, change_type, old_value, new_value, reason)
        VALUES (_r.id, _r.organization_id, _r.business_id, 'archive',
          jsonb_build_object('is_active', true),
          jsonb_build_object('is_active', false),
          'Archived legacy statutory account globally seeded; install localization pack for current statutory accounts');
      END IF;
    ELSE
      -- No postings: rename + archive so the row stays visible as legacy.
      _new_name := _r.name || ' (legacy — install country localization pack)';
      UPDATE public.accounts
      SET name = _new_name, is_active = false
      WHERE id = _r.id;
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, reason)
      VALUES (_r.id, _r.organization_id, _r.business_id, 'rename',
        jsonb_build_object('name', _r.name, 'is_active', _r.is_active),
        jsonb_build_object('name', _new_name, 'is_active', false),
        'Statutory account leaked from global seed; renamed/archived during COA overhaul');
    END IF;
  END LOOP;
END $repair$;

-- ------------------------------------------------------------------
-- 4. enforce_account_lifecycle trigger — DB-level protection.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_account_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _has_postings boolean;
  _is_mapped boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) INTO _has_postings;
    SELECT EXISTS (SELECT 1 FROM public.default_account_settings WHERE account_id = OLD.id) INTO _is_mapped;

    IF OLD.is_system THEN
      RAISE EXCEPTION 'Cannot delete system account "%". Archive it instead.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF _has_postings THEN
      RAISE EXCEPTION 'Cannot delete account "%": it has posted transactions. Archive it instead.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF _is_mapped THEN
      RAISE EXCEPTION 'Cannot delete account "%": it is mapped as a default account. Reassign the mapping first.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO public.account_change_audit_log
      (account_id, organization_id, business_id, change_type, old_value, changed_by, reason)
    VALUES (OLD.id, OLD.organization_id, OLD.business_id, 'delete',
      to_jsonb(OLD), auth.uid(), 'User-initiated delete');
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- type/code changes
    IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
      IF OLD.is_system THEN
        RAISE EXCEPTION 'Cannot change account_type of system account "%".', OLD.name
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) INTO _has_postings;
      IF _has_postings THEN
        RAISE EXCEPTION 'Cannot change account_type of "%": % has posted transactions.', OLD.name, OLD.code
          USING ERRCODE = 'restrict_violation';
      END IF;
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'type_change',
        jsonb_build_object('account_type', OLD.account_type),
        jsonb_build_object('account_type', NEW.account_type),
        auth.uid());
    END IF;

    IF NEW.code IS DISTINCT FROM OLD.code THEN
      IF OLD.is_system THEN
        RAISE EXCEPTION 'Cannot change code of system account "%".', OLD.name
          USING ERRCODE = 'restrict_violation';
      END IF;
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'recode',
        jsonb_build_object('code', OLD.code),
        jsonb_build_object('code', NEW.code),
        auth.uid());
    END IF;

    IF NEW.name IS DISTINCT FROM OLD.name THEN
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'rename',
        jsonb_build_object('name', OLD.name),
        jsonb_build_object('name', NEW.name),
        auth.uid());
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id,
        CASE WHEN NEW.is_active THEN 'restore' ELSE 'archive' END,
        jsonb_build_object('is_active', OLD.is_active),
        jsonb_build_object('is_active', NEW.is_active),
        auth.uid());
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_account_lifecycle ON public.accounts;
CREATE TRIGGER trg_enforce_account_lifecycle
  BEFORE UPDATE OR DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_lifecycle();

-- ------------------------------------------------------------------
-- 5. validate_required_system_roles — used by UI after import.
--    Returns the list of system-role keys that have no mapping for the
--    given business so the UI can prompt the user to fix it.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_required_system_roles(_business_id uuid)
RETURNS TABLE(setting_key text, is_required boolean, suggested_account_type text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH required(setting_key, is_required, suggested_account_type) AS (
    VALUES
      ('cash',                   true,  'asset'),
      ('bank',                   true,  'asset'),
      ('accounts_receivable',    true,  'asset'),
      ('accounts_payable',       true,  'liability'),
      ('sales_revenue',          true,  'income'),
      ('cost_of_goods_sold',     false, 'expense'),
      ('inventory',              false, 'asset'),
      ('inventory_adjustment',   false, 'expense'),
      ('output_tax',             false, 'liability'),
      ('input_tax',              false, 'asset'),
      ('opening_balance_equity', true,  'equity'),
      ('retained_earnings',      true,  'equity'),
      ('suspense',               false, 'asset')
  )
  SELECT r.setting_key, r.is_required, r.suggested_account_type
  FROM required r
  LEFT JOIN public.default_account_settings d
    ON d.business_id = _business_id AND d.setting_key = r.setting_key
  WHERE d.id IS NULL
  ORDER BY r.is_required DESC, r.setting_key;
$$;

GRANT EXECUTE ON FUNCTION public.validate_required_system_roles(uuid) TO authenticated;
