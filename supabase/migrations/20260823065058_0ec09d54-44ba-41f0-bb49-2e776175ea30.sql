-- Budget lines become analytic-aware: the natural key must include the analytic
-- dimension, otherwise two plan lines for the same GL account and month but a
-- different cost centre collide.
ALTER TABLE public.budget_items
  DROP CONSTRAINT IF EXISTS budget_items_budget_id_account_id_period_month_key;

CREATE UNIQUE INDEX IF NOT EXISTS budget_items_budget_account_month_analytic_key
  ON public.budget_items (budget_id, account_id, period_month, analytic_account_id)
  NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION public._budget_items_normalize()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b record;
  fp record;
  acct record;
  an record;
  revising boolean;
BEGIN
  SELECT id, organization_id, business_id, fiscal_year, status
  INTO b
  FROM public.budgets
  WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget % not found', COALESCE(NEW.budget_id, OLD.budget_id);
  END IF;

  revising := COALESCE(current_setting('app.budget_revision', true), '') = b.id::text;

  IF b.status = 'closed' THEN
    RAISE EXCEPTION 'This budget is closed; its lines are read-only.' USING ERRCODE = '23514';
  END IF;

  IF b.status = 'active' AND NOT revising THEN
    RAISE EXCEPTION 'This budget is active. Record a budget revision instead of editing lines directly.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  NEW.business_id := b.business_id;

  SELECT id, business_id, account_type INTO acct
  FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % not found', NEW.account_id;
  END IF;
  IF acct.business_id <> b.business_id THEN
    RAISE EXCEPTION 'Account % belongs to a different business than this budget', NEW.account_id
      USING ERRCODE = '42501';
  END IF;

  -- Analytic attribution (optional). When present it must belong to the same
  -- business and must still accept new attribution.
  IF NEW.analytic_account_id IS NOT NULL THEN
    SELECT aa.id, aa.business_id, aa.status INTO an
    FROM public.analytic_accounts aa WHERE aa.id = NEW.analytic_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Analytic account % not found', NEW.analytic_account_id USING ERRCODE = '23503';
    END IF;
    IF an.business_id IS DISTINCT FROM b.business_id THEN
      RAISE EXCEPTION 'Analytic account % belongs to a different business than this budget', NEW.analytic_account_id
        USING ERRCODE = '42501';
    END IF;
    IF an.status <> 'active' THEN
      RAISE EXCEPTION 'Analytic account % is % and cannot receive new budget lines', NEW.analytic_account_id, an.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.fiscal_period_id IS NULL THEN
    SELECT m.period_id AS id, m.start_date, m.status
    INTO fp
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
    WHERE m.period_month = NEW.period_month
    ORDER BY m.start_date
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No monthly fiscal period exists for % / month % in this business. Provision fiscal periods first.',
        b.fiscal_year, NEW.period_month USING ERRCODE = '23503';
    END IF;
    NEW.fiscal_period_id := fp.id;
  ELSE
    SELECT m.period_id AS id, m.start_date, m.status
    INTO fp
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
    WHERE m.period_id = NEW.fiscal_period_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fiscal period % is not a monthly period of this budget''s business and fiscal year', NEW.fiscal_period_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- period_month / fiscal_year are derived display values
  NEW.period_month := EXTRACT(MONTH FROM fp.start_date)::int;

  -- A period lock governs POSTINGS, not PLANS. A draft budget may therefore be
  -- authored across periods that are already closed or locked. Once a budget is
  -- in force a closed period's plan line is frozen.
  IF b.status <> 'draft' AND fp.status <> 'open' THEN
    RAISE EXCEPTION 'Accounting period is % ; budget lines for it cannot be changed.', fp.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.budgeted_amount IS NULL OR NEW.budgeted_amount < 0 THEN
    RAISE EXCEPTION 'Budgeted amount must be zero or positive' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;