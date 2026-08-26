-- ---------------------------------------------------------------------------
-- Reproducibility: the following objects were applied to the database during
-- the interrupted Brick 3 run without a migration file. Re-declared here
-- verbatim (idempotent) so the schema can be rebuilt from history alone.
-- ---------------------------------------------------------------------------

ALTER TABLE public.consolidation_groups
  ADD COLUMN IF NOT EXISTS cta_account_id uuid REFERENCES public.accounts(id);
ALTER TABLE public.consolidation_group_members
  ADD COLUMN IF NOT EXISTS historical_rate_date date;

COMMENT ON COLUMN public.consolidation_groups.cta_account_id IS
  'Equity account of the parent company that carries the cumulative translation adjustment (IAS 21 / ASC 830).';
COMMENT ON COLUMN public.consolidation_group_members.historical_rate_date IS
  'Date whose spot rate is used as the historical rate for this member''s equity; defaults to the membership start.';

CREATE OR REPLACE FUNCTION public._consolidation_cta_account_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_acc public.accounts;
BEGIN
  IF NEW.cta_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_acc FROM public.accounts a WHERE a.id = NEW.cta_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The translation adjustment account does not exist' USING ERRCODE = '23514';
  END IF;
  IF v_acc.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'The translation adjustment account belongs to another organization' USING ERRCODE = '23514';
  END IF;
  IF v_acc.business_id IS DISTINCT FROM NEW.parent_business_id THEN
    RAISE EXCEPTION 'The translation adjustment account must belong to the parent company of the group' USING ERRCODE = '23514';
  END IF;
  IF v_acc.account_type <> 'equity'::public.account_type THEN
    RAISE EXCEPTION 'The translation adjustment must be carried in an equity account, not a % account', v_acc.account_type USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_acc.is_header, false) THEN
    RAISE EXCEPTION 'The translation adjustment account must be a postable account, not a heading' USING ERRCODE = '23514';
  END IF;
  IF NOT COALESCE(v_acc.is_active, true) THEN
    RAISE EXCEPTION 'The translation adjustment account is archived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS consolidation_cta_account_guard ON public.consolidation_groups;
CREATE TRIGGER consolidation_cta_account_guard
  BEFORE INSERT OR UPDATE OF cta_account_id, parent_business_id, organization_id
  ON public.consolidation_groups
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_cta_account_guard();

CREATE OR REPLACE FUNCTION public._consolidation_fy_start(_business_id uuid, _on_date date)
RETURNS date LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT CASE
           WHEN _on_date >= make_date(EXTRACT(YEAR FROM _on_date)::int, COALESCE(b.fiscal_year_start, 1), 1)
             THEN make_date(EXTRACT(YEAR FROM _on_date)::int, COALESCE(b.fiscal_year_start, 1), 1)
           ELSE make_date(EXTRACT(YEAR FROM _on_date)::int - 1, COALESCE(b.fiscal_year_start, 1), 1)
         END
    FROM public.businesses b
   WHERE b.id = _business_id;
$function$;

CREATE OR REPLACE FUNCTION public.fx_rate_on(_org_id uuid, _business_id uuid, _from_currency text, _to_currency text, _on_date date)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_rate numeric;
BEGIN
  IF _from_currency IS NULL OR _to_currency IS NULL OR _on_date IS NULL THEN
    RETURN NULL;
  END IF;
  IF upper(_from_currency) = upper(_to_currency) THEN
    RETURN 1;
  END IF;
  SELECT p.rate INTO v_rate
    FROM public._pick_exchange_rate_row(_org_id, _business_id, _from_currency, _to_currency, _on_date) p;
  RETURN v_rate;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fx_period_average_rate(_org_id uuid, _business_id uuid, _from_currency text, _to_currency text, _date_from date, _date_to date)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_avg numeric;
  v_uncovered int;
BEGIN
  IF _date_from IS NULL OR _date_to IS NULL OR _date_to < _date_from THEN
    RAISE EXCEPTION 'fx_period_average_rate: date_to must not precede date_from';
  END IF;
  IF _from_currency IS NULL OR _to_currency IS NULL THEN
    RETURN NULL;
  END IF;
  IF upper(_from_currency) = upper(_to_currency) THEN
    RETURN 1;
  END IF;

  WITH days AS (
    SELECT d::date AS day FROM generate_series(_date_from, _date_to, INTERVAL '1 day') d
  ),
  daily AS (
    SELECT public.fx_rate_on(_org_id, _business_id, _from_currency, _to_currency, days.day) AS rate FROM days
  )
  SELECT avg(rate), count(*) FILTER (WHERE rate IS NULL) INTO v_avg, v_uncovered FROM daily;

  IF v_uncovered > 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_avg;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consolidation_member_translation_rates(_group_id uuid, _business_id uuid, _date_from date, _date_to date)
RETURNS TABLE(from_currency text, to_currency text, historical_date date, closing_rate numeric, opening_rate numeric, average_rate numeric, prior_average_rate numeric, historical_rate numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_member public.consolidation_group_members;
  v_base text;
  v_hist date;
  v_prior_start date;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_member
    FROM public.consolidation_group_members m
   WHERE m.group_id = _group_id
     AND m.business_id = _business_id
     AND m.effective_from <= _date_to
     AND (m.effective_to IS NULL OR m.effective_to >= _date_to)
   ORDER BY m.effective_from DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That company is not a member of the group on %', _date_to;
  END IF;

  SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = _business_id;
  v_hist := COALESCE(v_member.historical_rate_date, v_member.effective_from);
  v_prior_start := public._consolidation_fy_start(_business_id, _date_from);

  RETURN QUERY SELECT
    v_base,
    v_group.presentation_currency,
    v_hist,
    public.fx_rate_on(v_group.organization_id, v_group.parent_business_id, v_base, v_group.presentation_currency, _date_to),
    public.fx_rate_on(v_group.organization_id, v_group.parent_business_id, v_base, v_group.presentation_currency, _date_from - 1),
    public.fx_period_average_rate(v_group.organization_id, v_group.parent_business_id, v_base, v_group.presentation_currency, _date_from, _date_to),
    CASE WHEN v_prior_start <= _date_from - 1
         THEN public.fx_period_average_rate(v_group.organization_id, v_group.parent_business_id, v_base, v_group.presentation_currency, v_prior_start, _date_from - 1)
         ELSE NULL END,
    public.fx_rate_on(v_group.organization_id, v_group.parent_business_id, v_base, v_group.presentation_currency, v_hist);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Brick 3 — the translation engine.
--
-- One member company's ledger, expressed in the group's presentation currency
-- under the current-rate method (IAS 21.39 / ASC 830-30):
--   * assets and liabilities  -> closing rate at the reporting date
--   * equity                  -> historical rate (rate when the equity arose)
--   * income and expenses     -> period average rate
--   * the resulting imbalance -> cumulative translation adjustment in equity
--
-- The adjustment is a RESIDUAL, never a plug someone types in: it is exactly
-- the amount that restores the translated trial balance to balance, and the
-- reconciliation function exposes opening + movement = closing for it.
--
-- Reads balances only through the authoritative ledger engine; SECURITY
-- INVOKER, so a caller who cannot see a member's ledger gets no numbers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_translate_member(
  _group_id uuid, _business_id uuid, _date_from date, _date_to date)
RETURNS TABLE(
  business_id uuid,
  business_name text,
  base_currency text,
  presentation_currency text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type account_type,
  is_nominal boolean,
  rate_class text,
  rate_used numeric,
  opening_balance numeric,
  total_debit numeric,
  total_credit numeric,
  closing_balance numeric,
  translated_opening numeric,
  translated_debit numeric,
  translated_credit numeric,
  translated_closing numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_biz public.businesses;
  v_r record;
  v_prior numeric;
  v_needs_translation boolean;
  v_open_cta numeric;
  v_close_cta numeric;
  v_move numeric;
  v_cta_account public.accounts;
BEGIN
  IF _group_id IS NULL OR _business_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_translate_member: group, company and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_translate_member: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_biz FROM public.businesses b WHERE b.id = _business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That company is not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_r
    FROM public.consolidation_member_translation_rates(_group_id, _business_id, _date_from, _date_to);

  v_needs_translation := upper(COALESCE(v_biz.base_currency, '')) <> upper(v_group.presentation_currency);

  IF v_needs_translation THEN
    IF v_group.cta_account_id IS NULL THEN
      RAISE EXCEPTION 'Group % has no translation adjustment account configured; % reports in % but the group presents in %',
        v_group.name, v_biz.name, v_biz.base_currency, v_group.presentation_currency
        USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_cta_account FROM public.accounts a WHERE a.id = v_group.cta_account_id;

    IF v_r.closing_rate IS NULL OR v_r.opening_rate IS NULL OR v_r.average_rate IS NULL OR v_r.historical_rate IS NULL THEN
      RAISE EXCEPTION 'Exchange rate coverage for %->% is incomplete over % to %; translation refused rather than approximated',
        v_r.from_currency, v_r.to_currency, _date_from, _date_to
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Pre-period retained results are carried at the prior period's average; when
  -- that cannot be computed honestly the historical rate is used instead, and
  -- any resulting difference lands in the translation adjustment where it is
  -- visible rather than hidden inside an account balance.
  v_prior := COALESCE(v_r.prior_average_rate, v_r.historical_rate);

  CREATE TEMP TABLE IF NOT EXISTS _consolidation_translation_scratch () ON COMMIT DROP;

  RETURN QUERY
  WITH opening AS (
    SELECT o.account_id, o.opening_balance, o.is_nominal
      FROM public.get_ledger_opening_balances(v_group.organization_id, _business_id, _date_from, NULL) o
  ),
  movement AS (
    SELECT mv.account_id, mv.total_debit, mv.total_credit
      FROM public.get_account_movements(v_group.organization_id, _date_from, _date_to, _business_id, NULL) mv
  ),
  combined AS (
    SELECT COALESCE(o.account_id, mv.account_id) AS account_id,
           COALESCE(o.opening_balance, 0)        AS opening_balance,
           COALESCE(o.is_nominal, false)         AS is_nominal,
           COALESCE(mv.total_debit, 0)           AS total_debit,
           COALESCE(mv.total_credit, 0)          AS total_credit
      FROM opening o
      FULL JOIN movement mv ON mv.account_id = o.account_id
  ),
  classified AS (
    SELECT c.account_id,
           a.code AS account_code,
           a.name AS account_name,
           a.account_type,
           c.is_nominal,
           c.opening_balance,
           c.total_debit,
           c.total_credit,
           (c.opening_balance + c.total_debit - c.total_credit) AS closing_balance,
           CASE
             WHEN a.account_type IN ('asset','liability') THEN 'closing'
             WHEN a.account_type = 'equity'               THEN 'historical'
             ELSE 'average'
           END AS rate_class
      FROM combined c
      JOIN public.accounts a ON a.id = c.account_id
     WHERE a.organization_id = v_group.organization_id
       AND (c.opening_balance <> 0 OR c.total_debit <> 0 OR c.total_credit <> 0)
  ),
  translated AS (
    SELECT cl.*,
           CASE cl.rate_class
             WHEN 'closing'    THEN v_r.closing_rate
             WHEN 'historical' THEN v_r.historical_rate
             ELSE v_r.average_rate
           END AS rate_used,
           round(cl.opening_balance * CASE cl.rate_class
                                        WHEN 'closing'    THEN v_r.opening_rate
                                        WHEN 'historical' THEN v_r.historical_rate
                                        ELSE v_prior
                                      END, 2) AS translated_opening,
           round(cl.total_debit * CASE cl.rate_class
                                    WHEN 'historical' THEN v_r.historical_rate
                                    ELSE v_r.average_rate
                                  END, 2) AS translated_debit,
           round(cl.total_credit * CASE cl.rate_class
                                     WHEN 'historical' THEN v_r.historical_rate
                                     ELSE v_r.average_rate
                                   END, 2) AS translated_credit
      FROM classified cl
  ),
  finalised AS (
    SELECT t.*,
           CASE t.rate_class
             WHEN 'closing'    THEN round(t.closing_balance * v_r.closing_rate, 2)
             WHEN 'historical' THEN round(t.closing_balance * v_r.historical_rate, 2)
             ELSE t.translated_opening + t.translated_debit - t.translated_credit
           END AS translated_closing
      FROM translated t
  )
  SELECT v_biz.id, v_biz.name, v_biz.base_currency, v_group.presentation_currency,
         f.account_id, f.account_code, f.account_name, f.account_type, f.is_nominal,
         f.rate_class, f.rate_used,
         f.opening_balance, f.total_debit, f.total_credit, f.closing_balance,
         f.translated_opening, f.translated_debit, f.translated_credit, f.translated_closing
    FROM finalised f
   ORDER BY f.account_code;

  IF NOT v_needs_translation THEN
    RETURN;
  END IF;

  -- The residual: whatever it takes to bring the translated ledger back into
  -- balance is, by definition, the cumulative translation adjustment.
  SELECT COALESCE(-sum(x.translated_opening), 0), COALESCE(-sum(x.translated_closing), 0)
    INTO v_open_cta, v_close_cta
    FROM public.consolidation_translate_member(_group_id, _business_id, _date_from, _date_to) x
   WHERE x.rate_class <> 'residual';

  v_move := v_close_cta - v_open_cta;

  RETURN QUERY SELECT
    v_biz.id, v_biz.name, v_biz.base_currency, v_group.presentation_currency,
    v_cta_account.id, v_cta_account.code, v_cta_account.name, v_cta_account.account_type,
    false,
    'residual'::text,
    NULL::numeric,
    0::numeric, 0::numeric, 0::numeric, 0::numeric,
    v_open_cta,
    GREATEST(v_move, 0),
    GREATEST(-v_move, 0),
    v_close_cta;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Scope: a foreign-currency member is now a translatable member, not a dead
-- end. It is still refused when the configuration cannot support an honest
-- translation.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.resolve_consolidation_scope(uuid, date);
CREATE FUNCTION public.resolve_consolidation_scope(_group_id uuid, _as_of date)
RETURNS TABLE(group_id uuid, group_name text, presentation_currency text, business_id uuid,
              business_name text, base_currency text, is_parent boolean, method consolidation_method,
              ownership_percent numeric, effective_from date, effective_to date,
              requires_translation boolean, blocker text)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_visible int;
  v_total int;
BEGIN
  IF _group_id IS NULL OR _as_of IS NULL THEN
    RAISE EXCEPTION 'resolve_consolidation_scope: _group_id and _as_of are required';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int INTO v_visible
    FROM public.consolidation_group_members m
   WHERE m.group_id = _group_id
     AND m.effective_from <= _as_of
     AND (m.effective_to IS NULL OR m.effective_to >= _as_of);

  v_total := public.consolidation_scope_member_count(_group_id, _as_of);

  IF v_visible = 0 THEN
    RAISE EXCEPTION 'Consolidation group % has no member companies as of %', v_group.name, _as_of;
  END IF;

  IF v_visible <> v_total THEN
    RAISE EXCEPTION 'You cannot access every company in group % as of % (% of % visible); consolidation refused',
      v_group.name, _as_of, v_visible, v_total
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    v_group.id,
    v_group.name,
    v_group.presentation_currency,
    b.id,
    b.name,
    b.base_currency,
    (b.id = v_group.parent_business_id) AS is_parent,
    m.method,
    m.ownership_percent,
    m.effective_from,
    m.effective_to,
    (COALESCE(b.base_currency, '') <> '' AND b.base_currency <> v_group.presentation_currency) AS requires_translation,
    CASE
      WHEN m.method = 'equity' THEN 'equity_method_not_supported_yet'
      WHEN COALESCE(b.base_currency, '') = '' THEN 'member_has_no_base_currency'
      WHEN m.ownership_percent IS NULL THEN 'ownership_percent_missing'
      WHEN b.base_currency <> v_group.presentation_currency
           AND v_group.cta_account_id IS NULL THEN 'cta_account_not_configured'
      WHEN b.base_currency <> v_group.presentation_currency
           AND public.fx_period_average_rate(v_group.organization_id, v_group.parent_business_id,
                 b.base_currency, v_group.presentation_currency,
                 public._consolidation_fy_start(b.id, _as_of), _as_of) IS NULL
        THEN 'insufficient_rate_coverage'
      ELSE NULL
    END AS blocker
  FROM public.consolidation_group_members m
  JOIN public.businesses b ON b.id = m.business_id
  WHERE m.group_id = _group_id
    AND m.effective_from <= _as_of
    AND (m.effective_to IS NULL OR m.effective_to >= _as_of)
  ORDER BY (b.id = v_group.parent_business_id) DESC, b.name;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The untranslated report keeps its old meaning: same-currency groups only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_consolidated_trial_balance(_group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(business_id uuid, business_name text, is_parent boolean, ownership_percent numeric,
              account_id uuid, account_code text, account_name text, account_type account_type,
              is_nominal boolean, opening_balance numeric, total_debit numeric, total_credit numeric,
              closing_balance numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_org uuid;
  v_blocker text;
  v_member record;
  v_fx int;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance: date_to must not precede date_from';
  END IF;

  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;

  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation blocked: %', v_blocker;
  END IF;

  -- This report reports the ledger as kept. A member on another currency needs
  -- get_consolidated_trial_balance_translated, which states its rates.
  SELECT count(*)::int INTO v_fx
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.requires_translation;
  IF v_fx > 0 THEN
    RAISE EXCEPTION 'Consolidation blocked: currency_translation_required';
  END IF;

  SELECT g.organization_id INTO v_org
    FROM public.consolidation_groups g WHERE g.id = _group_id;

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.is_parent, s.ownership_percent
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    WITH opening AS (
      SELECT o.account_id, o.opening_balance, o.is_nominal
        FROM public.get_ledger_opening_balances(v_org, v_member.business_id, _date_from, NULL) o
    ),
    movement AS (
      SELECT mv.account_id, mv.total_debit, mv.total_credit
        FROM public.get_account_movements(v_org, _date_from, _date_to, v_member.business_id, NULL) mv
    ),
    combined AS (
      SELECT COALESCE(o.account_id, mv.account_id) AS account_id,
             COALESCE(o.opening_balance, 0)        AS opening_balance,
             COALESCE(o.is_nominal, false)         AS is_nominal,
             COALESCE(mv.total_debit, 0)           AS total_debit,
             COALESCE(mv.total_credit, 0)          AS total_credit
        FROM opening o
        FULL JOIN movement mv ON mv.account_id = o.account_id
    )
    SELECT
      v_member.business_id, v_member.business_name, v_member.is_parent, v_member.ownership_percent,
      c.account_id, a.code, a.name, a.account_type, c.is_nominal,
      c.opening_balance, c.total_debit, c.total_credit,
      (c.opening_balance + c.total_debit - c.total_credit) AS closing_balance
    FROM combined c
    JOIN public.accounts a ON a.id = c.account_id
    WHERE a.organization_id = v_org
      AND (c.opening_balance <> 0 OR c.total_debit <> 0 OR c.total_credit <> 0);
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The translated group report: every member expressed in the presentation
-- currency, with the rate and rate class that produced each figure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_consolidated_trial_balance_translated(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(
  business_id uuid, business_name text, is_parent boolean, ownership_percent numeric,
  base_currency text, presentation_currency text,
  account_id uuid, account_code text, account_name text, account_type account_type,
  is_nominal boolean, rate_class text, rate_used numeric,
  opening_balance numeric, total_debit numeric, total_credit numeric, closing_balance numeric,
  translated_opening numeric, translated_debit numeric, translated_credit numeric, translated_closing numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_blocker text;
  v_member record;
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

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.is_parent, s.ownership_percent
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    SELECT v_member.business_id, v_member.business_name, v_member.is_parent, v_member.ownership_percent,
           t.base_currency, t.presentation_currency,
           t.account_id, t.account_code, t.account_name, t.account_type, t.is_nominal,
           t.rate_class, t.rate_used,
           t.opening_balance, t.total_debit, t.total_credit, t.closing_balance,
           t.translated_opening, t.translated_debit, t.translated_credit, t.translated_closing
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- "Where did the translation adjustment come from?" — opening + movement =
-- closing, per member, with the rates that produced it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_cta_reconciliation(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(
  business_id uuid, business_name text, base_currency text, presentation_currency text,
  opening_rate numeric, closing_rate numeric, average_rate numeric, historical_rate numeric,
  opening_cta numeric, cta_movement numeric, closing_cta numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_member record;
  v_rates record;
  v_cta record;
BEGIN
  FOR v_member IN
    SELECT s.business_id, s.business_name, s.requires_translation
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    CONTINUE WHEN NOT v_member.requires_translation;

    SELECT * INTO v_rates
      FROM public.consolidation_member_translation_rates(_group_id, v_member.business_id, _date_from, _date_to);

    SELECT t.base_currency, t.presentation_currency, t.translated_opening, t.translated_closing
      INTO v_cta
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t
     WHERE t.rate_class = 'residual'
     LIMIT 1;

    RETURN QUERY SELECT
      v_member.business_id, v_member.business_name, v_cta.base_currency, v_cta.presentation_currency,
      v_rates.opening_rate, v_rates.closing_rate, v_rates.average_rate, v_rates.historical_rate,
      v_cta.translated_opening,
      v_cta.translated_closing - v_cta.translated_opening,
      v_cta.translated_closing;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Privileges: consolidation is never anonymous.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fx_rate_on(uuid, uuid, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fx_period_average_rate(uuid, uuid, text, text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._consolidation_fy_start(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consolidation_member_translation_rates(uuid, uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consolidation_translate_member(uuid, uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_consolidation_scope(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_consolidated_trial_balance_translated(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fx_rate_on(uuid, uuid, text, text, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fx_period_average_rate(uuid, uuid, text, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._consolidation_fy_start(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_member_translation_rates(uuid, uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_translate_member(uuid, uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_consolidation_scope(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_consolidated_trial_balance_translated(uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) TO authenticated, service_role;