-- =====================================================================
-- PHASE 3: attribution lives on the ledger, derived and reversible
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.journal_entry_line_analytics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  journal_entry_line_id uuid NOT NULL REFERENCES public.journal_entry_lines(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.analytic_plans(id) ON DELETE RESTRICT,
  analytic_account_id uuid NOT NULL REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT,
  -- Signed like the ledger: debit positive, credit negative. A reversal
  -- therefore produces the exact negative, and the axis nets to zero.
  amount numeric(20,6) NOT NULL,
  percentage numeric(9,6) NOT NULL DEFAULT 100,
  entry_date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jela_percentage_range CHECK (percentage > 0 AND percentage <= 100),
  CONSTRAINT jela_one_value_per_plan_per_line UNIQUE (journal_entry_line_id, plan_id, analytic_account_id)
);

GRANT SELECT ON public.journal_entry_line_analytics TO authenticated;
GRANT ALL ON public.journal_entry_line_analytics TO service_role;
ALTER TABLE public.journal_entry_line_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY jela_select ON public.journal_entry_line_analytics
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read'));

CREATE INDEX IF NOT EXISTS idx_jela_account_date
  ON public.journal_entry_line_analytics (business_id, analytic_account_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_jela_plan_date
  ON public.journal_entry_line_analytics (business_id, plan_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_jela_entry
  ON public.journal_entry_line_analytics (journal_entry_id);

-- ---------------------------------------------------------------------
-- Attribution is derived from the posted line, never side-written. The
-- reversal engine already copies analytic_account_id onto the mirrored
-- line, so the contra allocation falls out of this trigger for free.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._jel_sync_analytics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_acct   record;
  v_date   date;
  v_signed numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
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
$$;

DROP TRIGGER IF EXISTS trg_jel_sync_analytics ON public.journal_entry_lines;
CREATE TRIGGER trg_jel_sync_analytics
  AFTER INSERT OR UPDATE OF analytic_account_id, debit, credit
  ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public._jel_sync_analytics();

-- ---------------------------------------------------------------------
-- Stop the parallel expense-only ledger: no side-write, no delete-on-void.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_expense_gl(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src text;
BEGIN
  -- Body is unchanged except for the removal of the analytic_distributions
  -- side-write; attribution now flows from the journal line itself.
  RETURN public._post_expense_gl_impl(p_expense_id);
END;
$function$;

-- Rebuild the real implementation from the current definition, minus the
-- distribution insert.
DO $do$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_expense_gl_v_orig'
   LIMIT 1;
  IF v_def IS NULL THEN
    RAISE NOTICE 'no snapshot needed';
  END IF;
END
$do$;

-- Simpler and safer than string surgery: recreate post_expense_gl as a thin
-- wrapper is not acceptable, so restore the original body verbatim with the
-- distribution block removed.
DROP FUNCTION IF EXISTS public.post_expense_gl(uuid);

CREATE OR REPLACE FUNCTION public.post_expense_gl(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_exp record;
  v_expense_acct uuid;
  v_payment_acct uuid;
  v_input_tax_acct uuid;
  v_existing uuid;
  v_net numeric;
  v_has_tax boolean;
  v_lines jsonb;
  v_je_id uuid;
  v_bill_id uuid;
  v_doc_no text;
  v_analytic uuid;
BEGIN
  SELECT e.id, e.organization_id, e.business_id, e.branch_id, e.expense_date,
         COALESCE(e.amount, 0) AS amount, COALESCE(e.tax_amount, 0) AS tax_amount,
         e.description, e.reference, e.payment_method, e.account_id, e.paid_by,
         e.payment_account_id, e.category_id, e.journal_entry_id, e.status::text AS status,
         e.currency, e.exchange_rate AS exchange_rate, e.expense_number,
         COALESCE(e.tax_treatment, 'recoverable') AS tax_treatment,
         e.analytic_account_id, e.project_id
    INTO v_exp
    FROM public.expenses e
   WHERE e.id = p_expense_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id USING ERRCODE = '22023';
  END IF;

  IF v_exp.exchange_rate IS NULL OR v_exp.exchange_rate <= 0 THEN
    RAISE EXCEPTION 'Expense % has no exchange rate on file for % — it cannot be posted at parity',
      p_expense_id, v_exp.currency USING ERRCODE = '23514';
  END IF;

  PERFORM public._assert_org_member(v_exp.organization_id);

  IF v_exp.status NOT IN ('approved', 'paid') THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'not_approved');
  END IF;

  IF v_exp.amount <= 0 THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'zero_amount');
  END IF;

  SELECT id INTO v_existing
    FROM public.journal_entries
   WHERE organization_id = v_exp.organization_id
     AND source_type = 'expense'
     AND source_id = p_expense_id
     AND status <> 'void'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE public.expenses SET journal_entry_id = v_existing WHERE id = p_expense_id;
    RETURN jsonb_build_object('journal_entry_id', v_existing, 'idempotent_replay', true);
  END IF;

  SELECT id INTO v_bill_id FROM public.bills WHERE source_expense_id = p_expense_id LIMIT 1;
  IF v_bill_id IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'bill_owns_liability', 'bill_id', v_bill_id);
  END IF;

  v_expense_acct := v_exp.account_id;

  IF v_expense_acct IS NULL AND v_exp.category_id IS NOT NULL THEN
    SELECT account_id INTO v_expense_acct
      FROM public.expense_categories WHERE id = v_exp.category_id;
  END IF;

  IF v_expense_acct IS NULL THEN
    v_expense_acct := public.resolve_expense_default_account(
      v_exp.organization_id, v_exp.business_id, 'operating_expenses');
  END IF;

  v_payment_acct := v_exp.payment_account_id;

  IF v_payment_acct IS NULL AND v_exp.paid_by = 'employee' THEN
    v_payment_acct := COALESCE(
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'employee_reimbursements_payable'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'net_salary_payable'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'accounts_payable'));
  END IF;

  IF v_payment_acct IS NULL AND v_exp.paid_by = 'company_card' THEN
    v_payment_acct := COALESCE(
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'credit_card_clearing'),
      public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'));
  END IF;

  IF v_payment_acct IS NULL THEN
    v_payment_acct := CASE COALESCE(v_exp.payment_method, 'cash')
      WHEN 'cash' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
      WHEN 'petty_cash' THEN
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash')
      WHEN 'bank' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'))
      WHEN 'credit_card' THEN COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'credit_card_clearing'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'))
      ELSE COALESCE(
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'bank'),
        public.resolve_expense_default_account(v_exp.organization_id, v_exp.business_id, 'cash'))
    END;
  END IF;

  IF v_expense_acct IS NULL OR v_payment_acct IS NULL THEN
    RAISE EXCEPTION 'Expense % cannot be posted: expense or payment account is not configured', p_expense_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM public._assert_expense_account_postable(v_expense_acct);

  v_has_tax := v_exp.tax_amount > 0 AND v_exp.tax_treatment = 'recoverable';
  v_net := CASE WHEN v_has_tax THEN v_exp.amount - v_exp.tax_amount ELSE v_exp.amount END;

  IF v_has_tax THEN
    v_input_tax_acct := public.resolve_expense_default_account(
      v_exp.organization_id, v_exp.business_id, 'input_tax');
    IF v_input_tax_acct IS NULL THEN
      v_has_tax := false;
      v_net := v_exp.amount;
    END IF;
  END IF;

  v_doc_no := COALESCE(v_exp.expense_number, v_exp.reference, p_expense_id::text);

  v_analytic := v_exp.analytic_account_id;

  IF v_analytic IS NULL AND v_exp.project_id IS NOT NULL THEN
    SELECT aa.id INTO v_analytic
      FROM public.projects p
      JOIN public.analytic_accounts aa
        ON aa.business_id = p.business_id
       AND aa.code = p.analytic_account_code
     WHERE p.id = v_exp.project_id
       AND aa.status = 'active'
     LIMIT 1;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_expense_acct,
      'description', 'Expense ' || v_doc_no || COALESCE(' - ' || NULLIF(v_exp.description, ''), ''),
      'debit', v_net,
      'credit', 0,
      'analytic_account_id', v_analytic,
      'project_id', v_exp.project_id
    )
  );

  IF v_has_tax THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_input_tax_acct,
        'description', 'Input tax on expense ' || v_doc_no,
        'debit', v_exp.tax_amount,
        'credit', 0,
        'project_id', v_exp.project_id
      )
    );
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object(
      'account_id', v_payment_acct,
      'description', 'Payment for expense ' || v_doc_no,
      'debit', 0,
      'credit', v_exp.amount,
      'project_id', v_exp.project_id
    )
  );

  v_je_id := public.post_journal_entry_atomic(
    v_exp.organization_id,
    v_exp.business_id,
    v_exp.branch_id,
    v_exp.expense_date,
    'Expense ' || v_doc_no,
    'expense',
    p_expense_id,
    v_lines,
    v_exp.currency,
    v_exp.exchange_rate
  );

  UPDATE public.expenses SET journal_entry_id = v_je_id WHERE id = p_expense_id;

  RETURN jsonb_build_object(
    'journal_entry_id', v_je_id,
    'expense_account_id', v_expense_acct,
    'payment_account_id', v_payment_acct,
    'analytic_account_id', v_analytic,
    'tax_treatment', v_exp.tax_treatment,
    'net', v_net,
    'tax', CASE WHEN v_has_tax THEN v_exp.tax_amount ELSE 0 END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_expense_gl(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_expense_gl(uuid) TO authenticated, service_role;