-- Helper: accountant-or-better gate used across new finance objects.
CREATE OR REPLACE FUNCTION public.is_finance_manager(_user_id UUID, _org_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
       public.has_role(_user_id, _org_id, 'owner'::app_role)
    OR public.has_role(_user_id, _org_id, 'admin'::app_role)
    OR public.has_role(_user_id, _org_id, 'accountant'::app_role)
    OR public.has_role(_user_id, _org_id, 'super_admin'::app_role);
$$;

-- =========================================================================
-- MIGRATION 5: JOURNAL BOOKS (Odoo "account.journal" parity)
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.journal_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  journal_type TEXT NOT NULL CHECK (journal_type IN ('sale','purchase','bank','cash','general','situation')),
  default_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_system BOOLEAN NOT NULL DEFAULT false,
  sequence_prefix TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT journal_books_business_code_uniq UNIQUE (business_id, code)
);

CREATE INDEX IF NOT EXISTS idx_journal_books_org_biz ON public.journal_books(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_journal_books_type   ON public.journal_books(business_id, journal_type) WHERE is_active;

ALTER TABLE public.journal_books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "journal_books_select" ON public.journal_books;
CREATE POLICY "journal_books_select" ON public.journal_books
  FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(organization_id));

DROP POLICY IF EXISTS "journal_books_insert" ON public.journal_books;
CREATE POLICY "journal_books_insert" ON public.journal_books
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

DROP POLICY IF EXISTS "journal_books_update" ON public.journal_books;
CREATE POLICY "journal_books_update" ON public.journal_books
  FOR UPDATE TO authenticated
  USING (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

DROP POLICY IF EXISTS "journal_books_delete" ON public.journal_books;
CREATE POLICY "journal_books_delete" ON public.journal_books
  FOR DELETE TO authenticated
  USING (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
    AND is_system = false
  );

CREATE TRIGGER trg_journal_books_updated
  BEFORE UPDATE ON public.journal_books
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS journal_book_id UUID REFERENCES public.journal_books(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_book
  ON public.journal_entries(journal_book_id) WHERE journal_book_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.seed_default_journal_books(_business_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id UUID;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  INSERT INTO public.journal_books (organization_id, business_id, code, name, journal_type, is_system, description)
  VALUES
    (_org_id, _business_id, 'SAL',  'Sales Journal',     'sale',     true, 'Customer invoices and credit notes'),
    (_org_id, _business_id, 'PUR',  'Purchases Journal', 'purchase', true, 'Vendor bills and debit notes'),
    (_org_id, _business_id, 'BNK',  'Bank Journal',      'bank',     true, 'Bank deposits, withdrawals, and transfers'),
    (_org_id, _business_id, 'CSH',  'Cash Journal',      'cash',     true, 'Cash receipts and disbursements'),
    (_org_id, _business_id, 'MISC', 'Miscellaneous',     'general',  true, 'Manual journal entries and adjustments')
  ON CONFLICT (business_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_journal_books(UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.seed_default_journal_books(UUID) TO authenticated;

-- =========================================================================
-- MIGRATION 6: BANK RECONCILIATION AUTO-RULES
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.bank_reconciliation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  description_pattern TEXT,
  description_regex TEXT,
  reference_pattern TEXT,
  amount_min NUMERIC,
  amount_max NUMERIC,
  amount_sign TEXT CHECK (amount_sign IN ('debit','credit','any')) DEFAULT 'any',
  counterpart_contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  counterpart_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  journal_book_id UUID REFERENCES public.journal_books(id) ON DELETE SET NULL,
  auto_post BOOLEAN NOT NULL DEFAULT true,
  description_template TEXT,
  match_count INTEGER NOT NULL DEFAULT 0,
  last_matched_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recon_rules_priority ON public.bank_reconciliation_rules(business_id, priority) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_recon_rules_bank     ON public.bank_reconciliation_rules(bank_account_id) WHERE is_active;

ALTER TABLE public.bank_reconciliation_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recon_rules_select" ON public.bank_reconciliation_rules;
CREATE POLICY "recon_rules_select" ON public.bank_reconciliation_rules
  FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(organization_id));

DROP POLICY IF EXISTS "recon_rules_write" ON public.bank_reconciliation_rules;
CREATE POLICY "recon_rules_write" ON public.bank_reconciliation_rules
  FOR ALL TO authenticated
  USING (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  )
  WITH CHECK (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

CREATE TRIGGER trg_recon_rules_updated
  BEFORE UPDATE ON public.bank_reconciliation_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.apply_reconciliation_rules(
  _bank_account_id UUID,
  _user_id UUID DEFAULT NULL,
  _max_rows INTEGER DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ba RECORD;
  _txn RECORD;
  _rule RECORD;
  _bank_account_gl UUID;
  _je_id UUID;
  _je_number TEXT;
  _matched_count INT := 0;
  _processed INT := 0;
  _bank_dr NUMERIC; _bank_cr NUMERIC;
  _counter_dr NUMERIC; _counter_cr NUMERIC;
  _desc TEXT;
BEGIN
  SELECT * INTO _ba FROM public.bank_accounts WHERE id = _bank_account_id;
  IF _ba IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _bank_account_id;
  END IF;
  IF _ba.account_id IS NULL THEN
    RAISE EXCEPTION 'Bank account is not linked to a GL account';
  END IF;
  _bank_account_gl := _ba.account_id;

  FOR _txn IN
    SELECT *
    FROM public.bank_transactions
    WHERE bank_account_id = _bank_account_id
      AND COALESCE(is_reconciled, false) = false
      AND journal_entry_id IS NULL
    ORDER BY transaction_date
    LIMIT _max_rows
  LOOP
    _processed := _processed + 1;

    SELECT r.* INTO _rule
    FROM public.bank_reconciliation_rules r
    WHERE r.business_id = _ba.business_id
      AND r.is_active
      AND (r.bank_account_id IS NULL OR r.bank_account_id = _bank_account_id)
      AND (r.amount_min IS NULL OR ABS(_txn.amount) >= r.amount_min)
      AND (r.amount_max IS NULL OR ABS(_txn.amount) <= r.amount_max)
      AND (
        r.amount_sign = 'any'
        OR (r.amount_sign = 'debit'  AND _txn.amount > 0)
        OR (r.amount_sign = 'credit' AND _txn.amount < 0)
      )
      AND (r.description_pattern IS NULL OR _txn.description ILIKE r.description_pattern)
      AND (r.description_regex   IS NULL OR _txn.description ~* r.description_regex)
      AND (r.reference_pattern   IS NULL OR _txn.reference   ILIKE r.reference_pattern)
    ORDER BY r.priority ASC, r.created_at ASC
    LIMIT 1;

    CONTINUE WHEN _rule IS NULL;
    CONTINUE WHEN NOT _rule.auto_post;

    IF _txn.amount > 0 THEN
      _bank_dr := _txn.amount; _bank_cr := 0;
      _counter_dr := 0; _counter_cr := _txn.amount;
    ELSE
      _bank_dr := 0; _bank_cr := ABS(_txn.amount);
      _counter_dr := ABS(_txn.amount); _counter_cr := 0;
    END IF;

    _desc := COALESCE(_rule.description_template, _txn.description, _rule.name);
    _je_number := 'AR-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6);

    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id,
      entry_number, entry_date, description, reference,
      status, source_type, source_id,
      journal_book_id, posted_at, posted_by, created_by,
      total_debit, total_credit
    ) VALUES (
      _ba.organization_id, _ba.business_id, _ba.branch_id,
      _je_number, _txn.transaction_date, _desc, _txn.reference,
      'posted', 'bank_recon_rule', _txn.id,
      _rule.journal_book_id, now(), _user_id, _user_id,
      ABS(_txn.amount), ABS(_txn.amount)
    ) RETURNING id INTO _je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, description, debit, credit, line_order
    ) VALUES
      (_je_id, _bank_account_gl,             _desc, _bank_dr,    _bank_cr,    0),
      (_je_id, _rule.counterpart_account_id, _desc, _counter_dr, _counter_cr, 1);

    UPDATE public.bank_transactions
       SET is_reconciled    = true,
           reconciled_at    = now(),
           reconciled_by    = _user_id,
           reconciled_type  = 'rule',
           journal_entry_id = _je_id,
           match_source     = 'rule:' || _rule.name,
           match_confidence = 1.0
     WHERE id = _txn.id;

    UPDATE public.bank_reconciliation_rules
       SET match_count     = match_count + 1,
           last_matched_at = now()
     WHERE id = _rule.id;

    _matched_count := _matched_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', _processed, 'matched', _matched_count);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_reconciliation_rules(UUID, UUID, INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION public.apply_reconciliation_rules(UUID, UUID, INTEGER) TO authenticated;

-- =========================================================================
-- MIGRATION 7: FX REVALUATION
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.fx_revaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  base_currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  total_unrealized_gain NUMERIC NOT NULL DEFAULT 0,
  total_unrealized_loss NUMERIC NOT NULL DEFAULT 0,
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fx_revaluation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.fx_revaluation_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL,
  foreign_balance NUMERIC NOT NULL,
  old_rate NUMERIC NOT NULL,
  new_rate NUMERIC NOT NULL,
  base_balance_old NUMERIC NOT NULL,
  base_balance_new NUMERIC NOT NULL,
  delta NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_runs_biz  ON public.fx_revaluation_runs(business_id, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_fx_lines_run ON public.fx_revaluation_lines(run_id);

ALTER TABLE public.fx_revaluation_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluation_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fx_runs_select" ON public.fx_revaluation_runs;
CREATE POLICY "fx_runs_select" ON public.fx_revaluation_runs
  FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(organization_id));

DROP POLICY IF EXISTS "fx_runs_write" ON public.fx_revaluation_runs;
CREATE POLICY "fx_runs_write" ON public.fx_revaluation_runs
  FOR ALL TO authenticated
  USING (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  )
  WITH CHECK (
    public.user_belongs_to_org(organization_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

DROP POLICY IF EXISTS "fx_lines_select" ON public.fx_revaluation_lines;
CREATE POLICY "fx_lines_select" ON public.fx_revaluation_lines
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs r
    WHERE r.id = fx_revaluation_lines.run_id
      AND public.user_belongs_to_org(r.organization_id)
  ));

DROP POLICY IF EXISTS "fx_lines_write" ON public.fx_revaluation_lines;
CREATE POLICY "fx_lines_write" ON public.fx_revaluation_lines
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs r
    WHERE r.id = fx_revaluation_lines.run_id
      AND public.user_belongs_to_org(r.organization_id)
      AND public.is_finance_manager(auth.uid(), r.organization_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.fx_revaluation_runs r
    WHERE r.id = fx_revaluation_lines.run_id
      AND public.user_belongs_to_org(r.organization_id)
      AND public.is_finance_manager(auth.uid(), r.organization_id)
  ));

CREATE TRIGGER trg_fx_runs_updated
  BEFORE UPDATE ON public.fx_revaluation_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.revalue_fx_balances(
  _business_id UUID,
  _run_date DATE,
  _base_currency TEXT,
  _unrealized_gain_account UUID,
  _unrealized_loss_account UUID,
  _user_id UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id UUID;
  _run_id UUID;
  _je_id UUID;
  _je_number TEXT;
  _row RECORD;
  _new_rate NUMERIC;
  _line_seq INT := 0;
  _total_gain NUMERIC := 0;
  _total_loss NUMERIC := 0;
  _net_delta NUMERIC := 0;
  _base_new NUMERIC;
  _delta    NUMERIC;
  _old_rate NUMERIC;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  INSERT INTO public.fx_revaluation_runs (
    organization_id, business_id, run_date, base_currency, status, created_by
  ) VALUES (
    _org_id, _business_id, _run_date, _base_currency, 'draft', _user_id
  ) RETURNING id INTO _run_id;

  _je_number := 'FX-' || to_char(_run_date, 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, description,
    status, source_type, source_id, posted_at, posted_by, created_by,
    is_adjusting, total_debit, total_credit
  ) VALUES (
    _org_id, _business_id, _je_number, _run_date,
    'Unrealized FX revaluation as of ' || _run_date,
    'draft', 'fx_revaluation', _run_id, NULL, NULL, _user_id,
    true, 0, 0
  ) RETURNING id INTO _je_id;

  FOR _row IN
    SELECT
      jel.account_id,
      je.currency,
      SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) AS foreign_balance,
      SUM((COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) * COALESCE(je.exchange_rate,1)) AS base_balance_old
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date <= _run_date
      AND je.currency IS NOT NULL
      AND je.currency <> _base_currency
    GROUP BY jel.account_id, je.currency
    HAVING ABS(SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0))) > 0.01
  LOOP
    SELECT rate INTO _new_rate
    FROM public.exchange_rates
    WHERE business_id = _business_id
      AND from_currency = _row.currency
      AND to_currency = _base_currency
      AND effective_date <= _run_date
    ORDER BY effective_date DESC
    LIMIT 1;

    CONTINUE WHEN _new_rate IS NULL;

    _base_new := _row.foreign_balance * _new_rate;
    _delta    := _base_new - _row.base_balance_old;
    _old_rate := CASE WHEN _row.foreign_balance = 0 THEN _new_rate
                      ELSE _row.base_balance_old / _row.foreign_balance END;

    INSERT INTO public.fx_revaluation_lines (
      run_id, account_id, currency, foreign_balance,
      old_rate, new_rate, base_balance_old, base_balance_new, delta
    ) VALUES (
      _run_id, _row.account_id, _row.currency, _row.foreign_balance,
      _old_rate, _new_rate, _row.base_balance_old, _base_new, _delta
    );

    CONTINUE WHEN ABS(_delta) < 0.01;

    IF _delta > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, line_order)
      VALUES (_je_id, _row.account_id,            'FX reval ' || _row.currency || ' @ ' || _new_rate, _delta, 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, line_order)
      VALUES (_je_id, _unrealized_gain_account,   'FX reval ' || _row.currency || ' @ ' || _new_rate, 0, _delta, _line_seq);
      _line_seq := _line_seq + 1;
      _total_gain := _total_gain + _delta;
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, line_order)
      VALUES (_je_id, _unrealized_loss_account,   'FX reval ' || _row.currency || ' @ ' || _new_rate, ABS(_delta), 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, line_order)
      VALUES (_je_id, _row.account_id,            'FX reval ' || _row.currency || ' @ ' || _new_rate, 0, ABS(_delta), _line_seq);
      _line_seq := _line_seq + 1;
      _total_loss := _total_loss + ABS(_delta);
    END IF;
    _net_delta := _net_delta + _delta;
  END LOOP;

  IF _line_seq = 0 THEN
    DELETE FROM public.journal_entries WHERE id = _je_id;
    UPDATE public.fx_revaluation_runs
       SET status = 'posted', total_unrealized_gain = 0, total_unrealized_loss = 0, journal_entry_id = NULL
     WHERE id = _run_id;
    RETURN jsonb_build_object('success', true, 'run_id', _run_id, 'lines', 0, 'message', 'No FX deltas to post');
  END IF;

  UPDATE public.journal_entries
     SET status = 'posted',
         posted_at = now(),
         posted_by = _user_id,
         total_debit  = (SELECT COALESCE(SUM(debit),0)  FROM public.journal_entry_lines WHERE journal_entry_id = _je_id),
         total_credit = (SELECT COALESCE(SUM(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id = _je_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'posted',
         total_unrealized_gain = _total_gain,
         total_unrealized_loss = _total_loss,
         journal_entry_id = _je_id
   WHERE id = _run_id;

  RETURN jsonb_build_object(
    'success', true, 'run_id', _run_id, 'journal_entry_id', _je_id,
    'lines', _line_seq, 'unrealized_gain', _total_gain,
    'unrealized_loss', _total_loss, 'net_delta', _net_delta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revalue_fx_balances(UUID, DATE, TEXT, UUID, UUID, UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.revalue_fx_balances(UUID, DATE, TEXT, UUID, UUID, UUID) TO authenticated;