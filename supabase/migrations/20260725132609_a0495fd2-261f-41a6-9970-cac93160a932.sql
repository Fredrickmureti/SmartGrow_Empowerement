-- ============================================================
-- Loan subsystem — Phase 3 (default loan accounting) + Phase 4 (SoD duties)
-- ============================================================

INSERT INTO public.system_account_roles
  (role_key, label, description, category, required_account_type, is_mandatory, sort_order)
VALUES
  ('loan_receivable', 'Employee Loans Receivable',
   'Asset account carrying the outstanding principal owed by employees on staff loans and advances.',
   'payroll', 'asset', false, 260),
  ('loan_disbursement_clearing', 'Loan Disbursement Clearing',
   'Clearing account credited when a loan is granted and cleared when the funds actually leave the bank.',
   'payroll', 'asset', false, 261),
  ('loan_interest_income', 'Loan Interest Income',
   'Income account credited when interest is accrued on interest-bearing employee loans.',
   'payroll', 'income', false, 262),
  ('loan_writeoff_expense', 'Loan Write-off Expense',
   'Expense account debited when an irrecoverable employee loan balance is written off.',
   'payroll', 'expense', false, 263)
ON CONFLICT (role_key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      required_account_type = EXCLUDED.required_account_type;

INSERT INTO public.account_role_eligibility (role_key, detail_type, account_type, priority)
VALUES
  ('loan_receivable', 'employee_advances', 'asset', 1),
  ('loan_receivable', 'loans_to_others', 'asset', 2),
  ('loan_receivable', 'other_current_asset', 'asset', 3),
  ('loan_disbursement_clearing', 'other_current_asset', 'asset', 1),
  ('loan_disbursement_clearing', 'undeposited_funds', 'asset', 2),
  ('loan_interest_income', 'interest_income', 'income', 1),
  ('loan_interest_income', 'other_income', 'income', 2),
  ('loan_writeoff_expense', 'bad_debt_expense', 'expense', 1),
  ('loan_writeoff_expense', 'other_expense', 'expense', 2)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public._loan_ensure_account(
  _org uuid, _biz uuid, _role text, _code text, _name text,
  _type text, _detail text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_code text := _code; v_try int := 0;
BEGIN
  SELECT id INTO v_id FROM public.accounts
   WHERE business_id = _biz AND system_role = _role LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  WHILE EXISTS (SELECT 1 FROM public.accounts WHERE business_id=_biz AND code=v_code) LOOP
    v_try := v_try + 1;
    EXIT WHEN v_try > 50;
    v_code := (_code::int + v_try)::text;
  END LOOP;

  INSERT INTO public.accounts
    (organization_id, business_id, code, name, account_type, detail_type,
     system_role, is_system, is_active, is_header)
  VALUES
    (_org, _biz, v_code, _name, _type::account_type, _detail,
     _role, true, true, false)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_loan_gl_accounts(_org uuid, _biz uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_recv uuid; v_clear uuid; v_int uuid; v_wo uuid;
BEGIN
  IF _org IS NULL OR _biz IS NULL THEN RETURN '{}'::jsonb; END IF;

  v_recv  := public._loan_ensure_account(_org,_biz,'loan_receivable','1360',
              'Employee Loans Receivable','asset','employee_advances');
  v_clear := public._loan_ensure_account(_org,_biz,'loan_disbursement_clearing','1365',
              'Loan Disbursement Clearing','asset','other_current_asset');
  v_int   := public._loan_ensure_account(_org,_biz,'loan_interest_income','4310',
              'Loan Interest Income','income','interest_income');
  v_wo    := public._loan_ensure_account(_org,_biz,'loan_writeoff_expense','6420',
              'Loan Write-off Expense','expense','bad_debt_expense');

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id, source)
  VALUES
    (_org,_biz,'loan_receivable',v_recv,'system'),
    (_org,_biz,'loan_disbursement_clearing',v_clear,'system'),
    (_org,_biz,'loan_interest_income',v_int,'system'),
    (_org,_biz,'loan_writeoff_expense',v_wo,'system')
  ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;

  UPDATE public.loan_types lt
     SET gl_receivable_account_id            = COALESCE(lt.gl_receivable_account_id, v_recv),
         gl_disbursement_clearing_account_id = COALESCE(lt.gl_disbursement_clearing_account_id, v_clear),
         interest_income_account_id          = COALESCE(lt.interest_income_account_id, v_int),
         writeoff_account_id                 = COALESCE(lt.writeoff_account_id, v_wo)
   WHERE lt.organization_id = _org
     AND (lt.business_id = _biz OR lt.business_id IS NULL);

  RETURN jsonb_build_object(
    'loan_receivable', v_recv,
    'loan_disbursement_clearing', v_clear,
    'loan_interest_income', v_int,
    'loan_writeoff_expense', v_wo
  );
END $$;

GRANT EXECUTE ON FUNCTION public.ensure_loan_gl_accounts(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_loan_types_default_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_biz uuid;
BEGIN
  v_biz := COALESCE(NEW.business_id,
                    (SELECT id FROM public.businesses
                      WHERE organization_id = NEW.organization_id
                      ORDER BY created_at LIMIT 1));
  IF v_biz IS NULL THEN RETURN NEW; END IF;

  IF NEW.gl_receivable_account_id IS NULL THEN
    NEW.gl_receivable_account_id :=
      (SELECT id FROM public.accounts WHERE business_id=v_biz AND system_role='loan_receivable' LIMIT 1);
  END IF;
  IF NEW.gl_disbursement_clearing_account_id IS NULL THEN
    NEW.gl_disbursement_clearing_account_id :=
      (SELECT id FROM public.accounts WHERE business_id=v_biz AND system_role='loan_disbursement_clearing' LIMIT 1);
  END IF;
  IF NEW.interest_income_account_id IS NULL THEN
    NEW.interest_income_account_id :=
      (SELECT id FROM public.accounts WHERE business_id=v_biz AND system_role='loan_interest_income' LIMIT 1);
  END IF;
  IF NEW.writeoff_account_id IS NULL THEN
    NEW.writeoff_account_id :=
      (SELECT id FROM public.accounts WHERE business_id=v_biz AND system_role='loan_writeoff_expense' LIMIT 1);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_loan_types_default_accounts ON public.loan_types;
CREATE TRIGGER trg_loan_types_default_accounts
BEFORE INSERT ON public.loan_types
FOR EACH ROW EXECUTE FUNCTION public.tg_loan_types_default_accounts();

-- ---------- Loan duties in the existing SoD matrix (duty_a < duty_b) ----------
INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('loan.originate',  'Originate employee loans', 'payroll', 'Create or capture employee loan requests on behalf of staff.'),
  ('loan.approve',    'Approve employee loans',   'payroll', 'Authorise an employee loan request.'),
  ('loan.disburse',   'Disburse employee loans',  'finance', 'Release loan funds and post the disbursement to the ledger.'),
  ('loan.write_off',  'Write off employee loans', 'finance', 'Write off an irrecoverable employee loan balance.')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('loan.approve',  'loan.originate', 'high',
   'The person who raises a loan request must not be the person who approves it.'),
  ('loan.approve',  'loan.disburse',  'high',
   'Approving a loan and releasing the funds must be performed by different people.'),
  ('loan.disburse', 'loan.originate', 'critical',
   'Raising a loan and paying it out is a direct misappropriation path.'),
  ('loan.approve',  'loan.write_off', 'critical',
   'The approver of a loan must not be able to write off the same balance.')
ON CONFLICT DO NOTHING;

INSERT INTO public.governance_duty_permission_map (duty_code, module, operation) VALUES
  ('loan.originate', 'payroll', 'manageEmployeeLoans'),
  ('loan.approve',   'payroll', 'manageEmployeeLoans'),
  ('loan.disburse',  'finance', 'manageBankAccounts'),
  ('loan.write_off', 'finance', 'manageJournalEntries')
ON CONFLICT DO NOTHING;