-- ============================================================
-- Brick 4: group chart of accounts + explicit account mapping
-- ============================================================

ALTER TABLE public.consolidation_group_change_log
  DROP CONSTRAINT IF EXISTS consolidation_group_change_log_entity_check;
ALTER TABLE public.consolidation_group_change_log
  ADD CONSTRAINT consolidation_group_change_log_entity_check
  CHECK (entity = ANY (ARRAY['group'::text, 'member'::text, 'group_account'::text, 'mapping'::text]));

CREATE TABLE public.consolidation_group_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  account_type public.account_type NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_group_account_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT consolidation_group_account_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT consolidation_group_account_code_unique UNIQUE (group_id, code)
);

CREATE TABLE public.consolidation_account_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  group_account_id uuid NOT NULL REFERENCES public.consolidation_group_accounts(id) ON DELETE RESTRICT,
  effective_from date NOT NULL DEFAULT '0001-01-01'::date,
  effective_to date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_mapping_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX consolidation_group_accounts_group_idx
  ON public.consolidation_group_accounts (group_id, account_type, sort_order, code);
CREATE INDEX consolidation_account_mappings_lookup_idx
  ON public.consolidation_account_mappings (group_id, account_id, effective_from);
CREATE INDEX consolidation_account_mappings_group_account_idx
  ON public.consolidation_account_mappings (group_account_id);
CREATE INDEX consolidation_account_mappings_business_idx
  ON public.consolidation_account_mappings (group_id, business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_group_accounts TO authenticated;
GRANT ALL ON public.consolidation_group_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_account_mappings TO authenticated;
GRANT ALL ON public.consolidation_account_mappings TO service_role;

ALTER TABLE public.consolidation_group_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_account_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_group_accounts_select
  ON public.consolidation_group_accounts FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_group_accounts.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
  );

CREATE POLICY consolidation_group_accounts_write
  ON public.consolidation_group_accounts FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_group_accounts.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_group_accounts.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  );

-- A mapping exposes one company's account inside another company's group
-- report, so the caller must be able to reach BOTH the member company and the
-- group's parent company.
CREATE POLICY consolidation_account_mappings_select
  ON public.consolidation_account_mappings FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_account_mappings.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
  );

CREATE POLICY consolidation_account_mappings_write
  ON public.consolidation_account_mappings FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_account_mappings.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_account_mappings.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)
    )
  );

-- ------------------------------------------------------------
-- Integrity guards
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._consolidation_group_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group public.consolidation_groups;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group % does not exist', NEW.group_id;
  END IF;
  IF NEW.organization_id <> v_group.organization_id THEN
    RAISE EXCEPTION 'A group account must belong to the same organization as its consolidation group';
  END IF;
  NEW.code := btrim(NEW.code);
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._consolidation_mapping_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_account public.accounts;
  v_group_account public.consolidation_group_accounts;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group % does not exist', NEW.group_id;
  END IF;
  IF NEW.organization_id <> v_group.organization_id THEN
    RAISE EXCEPTION 'A mapping must belong to the same organization as its consolidation group';
  END IF;

  SELECT * INTO v_account FROM public.accounts a WHERE a.id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % does not exist', NEW.account_id;
  END IF;
  IF v_account.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'Account % belongs to a different company than the mapping claims', v_account.code;
  END IF;
  IF v_account.organization_id IS DISTINCT FROM v_group.organization_id THEN
    RAISE EXCEPTION 'Account % is outside the group organization', v_account.code;
  END IF;

  -- Only companies that are (or were) members of the group can be mapped.
  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id AND m.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'Company % is not a member of this consolidation group', NEW.business_id;
  END IF;

  SELECT * INTO v_group_account
    FROM public.consolidation_group_accounts ga WHERE ga.id = NEW.group_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group account % does not exist', NEW.group_account_id;
  END IF;
  IF v_group_account.group_id <> NEW.group_id THEN
    RAISE EXCEPTION 'Group account % belongs to another consolidation group', v_group_account.code;
  END IF;
  IF v_group_account.account_type <> v_account.account_type THEN
    RAISE EXCEPTION 'Account % is a % account and cannot map to group account % which is a % account',
      v_account.code, v_account.account_type, v_group_account.code, v_group_account.account_type
      USING ERRCODE = '22023';
  END IF;
  IF NOT v_group_account.is_active THEN
    RAISE EXCEPTION 'Group account % is inactive and cannot receive new mappings', v_group_account.code;
  END IF;

  -- The translation reserve is proved independently by the CTA reconciliation;
  -- mapping it as an ordinary line would double-count the reserve.
  IF v_group.cta_account_id IS NOT NULL AND NEW.account_id = v_group.cta_account_id THEN
    RAISE EXCEPTION 'Account % is the group translation reserve and is presented on its own; it cannot be mapped',
      v_account.code USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.consolidation_account_mappings m
     WHERE m.group_id = NEW.group_id
       AND m.account_id = NEW.account_id
       AND m.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND m.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
       AND NEW.effective_from < COALESCE(m.effective_to, 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Account % already has a group mapping covering that period; close the existing one first',
      v_account.code USING ERRCODE = '23505';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._consolidation_mapping_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.consolidation_group_change_log (
    organization_id, group_id, business_id, entity, action, actor_id, before_state, after_state
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.group_id, OLD.group_id),
    CASE WHEN TG_TABLE_NAME = 'consolidation_account_mappings'
         THEN COALESCE(NEW.business_id, OLD.business_id) END,
    CASE WHEN TG_TABLE_NAME = 'consolidation_account_mappings' THEN 'mapping' ELSE 'group_account' END,
    lower(TG_OP),
    auth.uid(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER consolidation_group_accounts_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_group_accounts
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_group_account_guard();
CREATE TRIGGER consolidation_group_accounts_log
  AFTER INSERT OR UPDATE OR DELETE ON public.consolidation_group_accounts
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_mapping_log();

CREATE TRIGGER consolidation_account_mappings_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_mapping_guard();
CREATE TRIGGER consolidation_account_mappings_log
  AFTER INSERT OR UPDATE OR DELETE ON public.consolidation_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_mapping_log();

REVOKE EXECUTE ON FUNCTION public._consolidation_cta_account_guard() FROM anon;

-- ------------------------------------------------------------
-- Does this group present through a group chart of accounts?
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_group_uses_group_chart(_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.consolidation_group_accounts ga
     WHERE ga.group_id = _group_id AND ga.is_active
  );
$$;

-- ------------------------------------------------------------
-- Posted accounts with no group mapping — the refusal evidence
-- and the settings worklist come from the same query.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_unmapped_accounts(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  business_id uuid, business_name text, account_id uuid,
  account_code text, account_name text, account_type public.account_type,
  closing_balance numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_member record;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_unmapped_accounts: group and date range are required';
  END IF;
  IF NOT public.consolidation_group_uses_group_chart(_group_id) THEN
    RETURN;
  END IF;

  FOR v_member IN
    SELECT s.business_id FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    SELECT t.business_id, t.business_name, t.account_id, t.account_code, t.account_name,
           t.account_type, t.closing_balance
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t
     WHERE t.rate_class <> 'residual'
       AND NOT EXISTS (
         SELECT 1 FROM public.consolidation_account_mappings m
          WHERE m.group_id = _group_id
            AND m.account_id = t.account_id
            AND m.effective_from <= _date_to
            AND (m.effective_to IS NULL OR m.effective_to >= _date_to)
       );
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- Trial balance: now carries the group account alongside the
-- originating company account (identity when there is no chart).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_consolidated_trial_balance_translated(uuid, date, date);

CREATE FUNCTION public.get_consolidated_trial_balance_translated(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  business_id uuid, business_name text, is_parent boolean, ownership_percent numeric,
  base_currency text, presentation_currency text,
  account_id uuid, account_code text, account_name text, account_type public.account_type,
  group_account_id uuid, group_account_code text, group_account_name text, is_mapped boolean,
  is_nominal boolean, rate_class text, rate_used numeric,
  opening_balance numeric, total_debit numeric, total_credit numeric, closing_balance numeric,
  translated_opening numeric, translated_debit numeric, translated_credit numeric, translated_closing numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_blocker text;
  v_member record;
  v_uses_chart boolean;
  v_unmapped text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance_translated: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance_translated: date_to must not precede date_from';
  END IF;

  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation blocked: %', v_blocker;
  END IF;

  v_uses_chart := public.consolidation_group_uses_group_chart(_group_id);

  -- An unmapped posted account can neither be dropped nor passed through as its
  -- own group line: either would manufacture a figure nobody chose.
  IF v_uses_chart THEN
    SELECT string_agg(format('%s %s (%s)', u.account_code, u.account_name, u.business_name), '; '
                      ORDER BY u.business_name, u.account_code)
      INTO v_unmapped
      FROM public.consolidation_unmapped_accounts(_group_id, _date_from, _date_to) u;
    IF v_unmapped IS NOT NULL THEN
      RAISE EXCEPTION 'These posted accounts have no group account mapping: %; map them before consolidating',
        v_unmapped USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.is_parent, s.ownership_percent
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    SELECT v_member.business_id, v_member.business_name, v_member.is_parent, v_member.ownership_percent,
           t.base_currency, t.presentation_currency,
           t.account_id, t.account_code, t.account_name, t.account_type,
           COALESCE(ga.id, t.account_id)     AS group_account_id,
           COALESCE(ga.code, t.account_code) AS group_account_code,
           COALESCE(ga.name, t.account_name) AS group_account_name,
           (ga.id IS NOT NULL)               AS is_mapped,
           t.is_nominal, t.rate_class, t.rate_used,
           t.opening_balance, t.total_debit, t.total_credit, t.closing_balance,
           t.translated_opening, t.translated_debit, t.translated_credit, t.translated_closing
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t
      LEFT JOIN public.consolidation_account_mappings m
             ON m.group_id = _group_id
            AND m.account_id = t.account_id
            AND m.effective_from <= _date_to
            AND (m.effective_to IS NULL OR m.effective_to >= _date_to)
            AND t.rate_class <> 'residual'
      LEFT JOIN public.consolidation_group_accounts ga ON ga.id = m.group_account_id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_trial_balance_translated(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consolidated_trial_balance_translated(uuid, date, date)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Statements: aggregate on the group account.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_consolidated_statement_lines(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  statement text, section text, section_order integer, account_id uuid,
  account_code text, account_name text, account_type public.account_type,
  is_residual boolean, is_derived boolean, presentation_currency text, amount numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH tb AS (
    SELECT * FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to)
  ),
  -- One line per GROUP account: member contributions are summed, never
  -- re-translated. Without a group chart the group account is the member
  -- account, so single-chart groups are unchanged.
  by_account AS (
    SELECT t.group_account_id                AS account_id,
           min(t.group_account_code)         AS account_code,
           min(t.group_account_name)         AS account_name,
           t.account_type,
           bool_or(t.rate_class = 'residual') AS is_residual,
           min(t.presentation_currency)       AS presentation_currency,
           sum(t.translated_debit)            AS translated_debit,
           sum(t.translated_credit)           AS translated_credit,
           sum(t.translated_closing)          AS translated_closing
      FROM tb t
     GROUP BY t.group_account_id, t.account_type
  ),
  lines AS (
    SELECT 'income_statement'::text AS statement,
           CASE WHEN a.account_type = 'income' THEN 'income' ELSE 'expense' END AS section,
           CASE WHEN a.account_type = 'income' THEN 1 ELSE 2 END AS section_order,
           a.account_id, a.account_code, a.account_name, a.account_type,
           a.is_residual, false AS is_derived, a.presentation_currency,
           CASE WHEN a.account_type = 'income'
                THEN a.translated_credit - a.translated_debit
                ELSE a.translated_debit - a.translated_credit
           END AS amount
      FROM by_account a
     WHERE a.account_type IN ('income', 'expense')

    UNION ALL

    SELECT 'balance_sheet',
           a.account_type::text,
           CASE a.account_type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
           a.account_id, a.account_code, a.account_name, a.account_type,
           a.is_residual, false, a.presentation_currency,
           a.translated_closing
      FROM by_account a
     WHERE a.account_type IN ('asset', 'liability', 'equity')

    UNION ALL

    -- The result earned so far this financial year is not posted to equity
    -- until the year closes, so the balance sheet carries it as its own line.
    SELECT 'balance_sheet', 'equity', 3,
           NULL::uuid, NULL::text, 'Result for the period', 'equity'::public.account_type,
           false, true, min(a.presentation_currency),
           COALESCE(sum(CASE WHEN a.account_type = 'income'
                             THEN a.translated_closing ELSE -a.translated_closing END), 0)
      FROM by_account a
     WHERE a.account_type IN ('income', 'expense')
    HAVING count(*) > 0
  )
  SELECT l.statement, l.section, l.section_order, l.account_id, l.account_code,
         l.account_name, l.account_type, l.is_residual, l.is_derived,
         l.presentation_currency, round(l.amount, 2)
    FROM lines l
   WHERE round(l.amount, 2) <> 0
   ORDER BY l.statement, l.section_order, l.is_derived, l.account_code NULLS LAST, l.account_name;
$$;

REVOKE ALL ON FUNCTION public.consolidation_group_uses_group_chart(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_group_uses_group_chart(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.consolidation_unmapped_accounts(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_unmapped_accounts(uuid, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) TO authenticated, service_role;