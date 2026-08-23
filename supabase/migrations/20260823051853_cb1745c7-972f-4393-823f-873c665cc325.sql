-- 1) Analytic attribution may never be rewritten on a posted/voided entry.
CREATE OR REPLACE FUNCTION public._jel_sync_analytics()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acct   record;
  v_date   date;
  v_status text;
  v_signed numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT je.status INTO v_status
      FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id;
    IF v_status IN ('posted', 'voided') THEN
      RAISE EXCEPTION
        'Analytic attribution of a % journal entry is immutable; reverse the entry instead', v_status
        USING ERRCODE = '23514';
    END IF;
    DELETE FROM public.journal_entry_line_analytics WHERE journal_entry_line_id = NEW.id;
  END IF;

  IF NEW.analytic_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT aa.id, aa.plan_id, aa.business_id, aa.status, aa.name
    INTO v_acct
    FROM public.analytic_accounts aa
   WHERE aa.id = NEW.analytic_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Analytic account % does not exist', NEW.analytic_account_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.business_id IS NOT NULL AND v_acct.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Analytic account "%" belongs to another company and cannot be attributed here', v_acct.name
      USING ERRCODE = '23514';
  END IF;

  IF v_acct.status <> 'active' THEN
    RAISE EXCEPTION 'Analytic account "%" is % and no longer accepts new postings', v_acct.name, v_acct.status
      USING ERRCODE = '23514';
  END IF;

  SELECT je.entry_date INTO v_date FROM public.journal_entries je WHERE je.id = NEW.journal_entry_id;
  v_signed := COALESCE(NEW.debit, 0) - COALESCE(NEW.credit, 0);

  IF v_signed = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.journal_entry_line_analytics (
    organization_id, business_id, branch_id, journal_entry_id, journal_entry_line_id,
    plan_id, analytic_account_id, amount, percentage, entry_date, description
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.journal_entry_id, NEW.id,
    v_acct.plan_id, NEW.analytic_account_id, v_signed, 100,
    COALESCE(v_date, CURRENT_DATE), NEW.description
  );

  RETURN NEW;
END;
$function$;

-- 2) Draft journal entry edits must preserve the line's analytic account.
CREATE OR REPLACE FUNCTION public.update_journal_entry_atomic(_entry_id uuid, _entry_date date, _description text, _reference text DEFAULT NULL::text, _is_adjusting boolean DEFAULT false, _is_closing boolean DEFAULT false, _lines jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _entry record;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _line jsonb;
  _idx int := 0;
BEGIN
  SELECT * INTO _entry FROM journal_entries WHERE id = _entry_id FOR UPDATE;
  IF _entry IS NULL THEN RAISE EXCEPTION 'Journal entry not found'; END IF;
  IF _entry.status != 'draft' THEN RAISE EXCEPTION 'Only draft entries can be updated (current status: %)', _entry.status; END IF;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit := _total_debit + coalesce((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + coalesce((_line->>'credit')::numeric, 0);
  END LOOP;

  IF abs(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Debits (%) must equal credits (%)', _total_debit, _total_credit;
  END IF;

  UPDATE journal_entries SET
    entry_date = _entry_date, description = _description, reference = _reference,
    is_adjusting = _is_adjusting, is_closing = _is_closing, updated_at = now()
  WHERE id = _entry_id;

  DELETE FROM journal_entry_lines WHERE journal_entry_id = _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, contact_id,
      analytic_account_id, sort_order
    ) VALUES (
      _entry_id, (_line->>'account_id')::uuid, _line->>'description',
      coalesce((_line->>'debit')::numeric, 0), coalesce((_line->>'credit')::numeric, 0),
      NULLIF(_line->>'contact_id','')::uuid,
      NULLIF(_line->>'analytic_account_id','')::uuid,
      _idx
    );
    _idx := _idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'entry_id', _entry_id);
END;
$function$;

-- 3) Analytic balances: ledger-only statuses ('void' never existed — the enum
--    value is 'voided', so voided entries were being counted), and branch scope.
DROP FUNCTION IF EXISTS public.analytic_balances(uuid, date, date, uuid);

CREATE OR REPLACE FUNCTION public.analytic_balances(
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_plan_id uuid DEFAULT NULL::uuid,
  p_branch_id uuid DEFAULT NULL::uuid
)
 RETURNS TABLE(analytic_account_id uuid, code text, name text, plan_id uuid, plan_name text, debit numeric, credit numeric, net numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT aa.id,
         aa.code,
         aa.name,
         ap.id,
         ap.name,
         COALESCE(SUM(a.amount) FILTER (WHERE a.amount > 0), 0),
         COALESCE(-SUM(a.amount) FILTER (WHERE a.amount < 0), 0),
         COALESCE(SUM(a.amount), 0)
    FROM public.analytic_accounts aa
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
    LEFT JOIN public.journal_entry_line_analytics a
           ON a.analytic_account_id = aa.id
          AND a.entry_date BETWEEN p_date_from AND p_date_to
          AND (p_branch_id IS NULL OR a.branch_id = p_branch_id)
          AND EXISTS (SELECT 1 FROM public.journal_entries je
                       WHERE je.id = a.journal_entry_id
                         AND je.status IN ('posted', 'reversed'))
   WHERE aa.business_id = p_business_id
     AND (p_plan_id IS NULL OR aa.plan_id = p_plan_id)
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), aa.organization_id, aa.business_id, 'financials', 'read')
   GROUP BY aa.id, aa.code, aa.name, ap.id, ap.name
   ORDER BY ap.name, aa.code NULLS LAST, aa.name;
$function$;

REVOKE ALL ON FUNCTION public.analytic_balances(uuid, date, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.analytic_balances(uuid, date, date, uuid, uuid) TO authenticated;