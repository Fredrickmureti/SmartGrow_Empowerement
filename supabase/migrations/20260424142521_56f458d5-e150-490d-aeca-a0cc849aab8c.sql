-- Phase completion hardening: journal taxonomy, branch/company isolation, reconciliation audit trail, and FX journal linkage.

-- 1) Canonical source aliases so idempotency cannot be bypassed by naming drift.
CREATE OR REPLACE FUNCTION public.normalize_journal_source_type(_source_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE lower(coalesce(_source_type, ''))
    WHEN 'invoices' THEN 'invoice'
    WHEN 'customer_invoice' THEN 'invoice'
    WHEN 'sales_invoice' THEN 'invoice'
    WHEN 'bills' THEN 'bill'
    WHEN 'vendor_bill' THEN 'bill'
    WHEN 'ap_bill' THEN 'bill'
    WHEN 'payments' THEN 'payment'
    WHEN 'customer_payment' THEN 'payment'
    WHEN 'receipt' THEN 'payment'
    WHEN 'bill_payments' THEN 'bill_payment'
    WHEN 'vendor_payment' THEN 'bill_payment'
    WHEN 'ap_payment' THEN 'bill_payment'
    WHEN 'bank_recon_rule' THEN 'bank_reconciliation'
    WHEN 'bank_rule' THEN 'bank_reconciliation'
    ELSE nullif(lower(coalesce(_source_type, '')), '')
  END;
$$;

CREATE OR REPLACE FUNCTION public.set_normalized_journal_source_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.source_type := public.normalize_journal_source_type(NEW.source_type);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_normalize_source_type ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_normalize_source_type
  BEFORE INSERT OR UPDATE OF source_type ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_normalized_journal_source_type();

CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_canonical_source
  ON public.journal_entries (
    organization_id,
    public.normalize_journal_source_type(source_type),
    source_id,
    COALESCE(source_subtype, 'main')
  )
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL AND status <> 'voided';

-- 2) Validate journal books, accounts, branches, and line scope at the database boundary.
CREATE OR REPLACE FUNCTION public.default_journal_book_for_source(
  _business_id uuid,
  _source_type text,
  _bank_account_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jb.id
  FROM public.journal_books jb
  WHERE jb.business_id = _business_id
    AND jb.is_active
    AND jb.journal_type = CASE
      WHEN public.normalize_journal_source_type(_source_type) = 'invoice' THEN 'sale'
      WHEN public.normalize_journal_source_type(_source_type) = 'bill' THEN 'purchase'
      WHEN public.normalize_journal_source_type(_source_type) IN ('payment','bill_payment','bank_reconciliation','bank_statement') THEN 'bank'
      WHEN public.normalize_journal_source_type(_source_type) IN ('fx_revaluation','inventory_valuation','asset_depreciation') THEN 'general'
      ELSE 'general'
    END
  ORDER BY jb.is_system DESC, jb.code
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.validate_journal_entry_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_book record;
  v_branch record;
  v_default_book uuid;
  v_has_books boolean;
BEGIN
  IF NEW.source_type IS NOT NULL THEN
    NEW.source_type := public.normalize_journal_source_type(NEW.source_type);
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_branch FROM public.branches WHERE id = NEW.branch_id;
    IF v_branch.organization_id IS DISTINCT FROM NEW.organization_id OR v_branch.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Journal entry branch does not belong to the same organization/company';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.journal_books jb WHERE jb.business_id = NEW.business_id AND jb.is_active
  ) INTO v_has_books;

  IF NEW.journal_book_id IS NULL AND NEW.status = 'posted' AND v_has_books THEN
    v_default_book := public.default_journal_book_for_source(NEW.business_id, NEW.source_type);
    IF v_default_book IS NOT NULL THEN
      NEW.journal_book_id := v_default_book;
    END IF;
  END IF;

  IF NEW.journal_book_id IS NOT NULL THEN
    SELECT organization_id, business_id, is_active INTO v_book FROM public.journal_books WHERE id = NEW.journal_book_id;
    IF v_book.organization_id IS DISTINCT FROM NEW.organization_id OR v_book.business_id IS DISTINCT FROM NEW.business_id OR COALESCE(v_book.is_active, false) = false THEN
      RAISE EXCEPTION 'Journal book must be active and belong to the same organization/company as the journal entry';
    END IF;
  ELSIF NEW.status = 'posted' AND v_has_books THEN
    RAISE EXCEPTION 'Posted journal entries require a journal book';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_validate_scope ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_validate_scope
  BEFORE INSERT OR UPDATE OF organization_id, business_id, branch_id, journal_book_id, source_type, status
  ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.validate_journal_entry_scope();

CREATE OR REPLACE FUNCTION public.validate_journal_entry_line_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry record;
  v_account record;
  v_branch record;
BEGIN
  SELECT organization_id, business_id, branch_id INTO v_entry
  FROM public.journal_entries WHERE id = NEW.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent journal entry not found';
  END IF;

  SELECT organization_id, business_id INTO v_account FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal line account not found';
  END IF;

  IF v_account.organization_id IS DISTINCT FROM v_entry.organization_id
     OR (v_account.business_id IS NOT NULL AND v_account.business_id IS DISTINCT FROM v_entry.business_id) THEN
    RAISE EXCEPTION 'Journal line account belongs to a different organization/company';
  END IF;

  NEW.business_id := COALESCE(NEW.business_id, v_entry.business_id);
  NEW.branch_id := COALESCE(NEW.branch_id, v_entry.branch_id);

  IF NEW.business_id IS DISTINCT FROM v_entry.business_id THEN
    RAISE EXCEPTION 'Journal line company must match parent journal entry';
  END IF;

  IF NEW.branch_id IS DISTINCT FROM v_entry.branch_id THEN
    RAISE EXCEPTION 'Journal line branch must match parent journal entry';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_branch FROM public.branches WHERE id = NEW.branch_id;
    IF v_branch.organization_id IS DISTINCT FROM v_entry.organization_id OR v_branch.business_id IS DISTINCT FROM v_entry.business_id THEN
      RAISE EXCEPTION 'Journal line branch belongs to a different organization/company';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entry_lines_validate_scope ON public.journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_validate_scope
  BEFORE INSERT OR UPDATE OF journal_entry_id, account_id, business_id, branch_id
  ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_journal_entry_line_scope();

-- 3) Durable Odoo-style reconciliation audit objects.
CREATE TABLE IF NOT EXISTS public.bank_reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  matched_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  matched_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  matched_bill_payment_id uuid REFERENCES public.bill_payments(id) ON DELETE SET NULL,
  matched_entity_type text,
  matched_entity_id uuid,
  matched_amount numeric NOT NULL DEFAULT 0,
  residual_amount numeric NOT NULL DEFAULT 0,
  match_type text NOT NULL DEFAULT 'suggestion' CHECK (match_type IN ('suggestion','manual','rule','auto','partial','writeoff')),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','reversed','to_check')),
  confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  rule_id uuid REFERENCES public.bank_reconciliation_rules(id) ON DELETE SET NULL,
  notes text,
  created_by uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  reversed_by uuid,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_reconciliation_writeoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_match_id uuid NOT NULL REFERENCES public.bank_reconciliation_matches(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  amount numeric NOT NULL,
  reason text NOT NULL DEFAULT 'writeoff',
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_txn ON public.bank_reconciliation_matches(bank_transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_business ON public.bank_reconciliation_matches(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_recon_writeoffs_match ON public.bank_reconciliation_writeoffs(reconciliation_match_id);

ALTER TABLE public.bank_reconciliation_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliation_writeoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_recon_matches_select" ON public.bank_reconciliation_matches;
CREATE POLICY "bank_recon_matches_select" ON public.bank_reconciliation_matches
  FOR SELECT TO authenticated
  USING (public.user_belongs_to_org(organization_id));

DROP POLICY IF EXISTS "bank_recon_matches_write" ON public.bank_reconciliation_matches;
CREATE POLICY "bank_recon_matches_write" ON public.bank_reconciliation_matches
  FOR ALL TO authenticated
  USING (public.user_belongs_to_org(organization_id) AND public.is_finance_manager(auth.uid(), organization_id))
  WITH CHECK (public.user_belongs_to_org(organization_id) AND public.is_finance_manager(auth.uid(), organization_id));

DROP POLICY IF EXISTS "bank_recon_writeoffs_select" ON public.bank_reconciliation_writeoffs;
CREATE POLICY "bank_recon_writeoffs_select" ON public.bank_reconciliation_writeoffs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.id = bank_reconciliation_writeoffs.reconciliation_match_id
      AND public.user_belongs_to_org(m.organization_id)
  ));

DROP POLICY IF EXISTS "bank_recon_writeoffs_write" ON public.bank_reconciliation_writeoffs;
CREATE POLICY "bank_recon_writeoffs_write" ON public.bank_reconciliation_writeoffs
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.id = bank_reconciliation_writeoffs.reconciliation_match_id
      AND public.user_belongs_to_org(m.organization_id)
      AND public.is_finance_manager(auth.uid(), m.organization_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.id = bank_reconciliation_writeoffs.reconciliation_match_id
      AND public.user_belongs_to_org(m.organization_id)
      AND public.is_finance_manager(auth.uid(), m.organization_id)
  ));

DROP TRIGGER IF EXISTS trg_bank_recon_matches_updated ON public.bank_reconciliation_matches;
CREATE TRIGGER trg_bank_recon_matches_updated
  BEFORE UPDATE ON public.bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.validate_bank_reconciliation_match_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_txn record;
  v_branch record;
BEGIN
  SELECT organization_id, business_id, bank_account_id INTO v_txn
  FROM public.bank_transactions WHERE id = NEW.bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transaction not found';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_txn.organization_id OR NEW.business_id IS DISTINCT FROM v_txn.business_id THEN
    RAISE EXCEPTION 'Reconciliation match must belong to the same organization/company as the bank transaction';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_branch FROM public.branches WHERE id = NEW.branch_id;
    IF v_branch.organization_id IS DISTINCT FROM NEW.organization_id OR v_branch.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Reconciliation branch must belong to the same organization/company';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_recon_matches_validate_scope ON public.bank_reconciliation_matches;
CREATE TRIGGER trg_bank_recon_matches_validate_scope
  BEFORE INSERT OR UPDATE OF organization_id, business_id, branch_id, bank_transaction_id
  ON public.bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.validate_bank_reconciliation_match_scope();

CREATE OR REPLACE FUNCTION public.validate_bank_reconciliation_writeoff_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_match record;
  v_account record;
BEGIN
  SELECT organization_id, business_id INTO v_match
  FROM public.bank_reconciliation_matches WHERE id = NEW.reconciliation_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reconciliation match not found';
  END IF;

  SELECT organization_id, business_id INTO v_account FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off account not found';
  END IF;

  IF v_account.organization_id IS DISTINCT FROM v_match.organization_id
     OR (v_account.business_id IS NOT NULL AND v_account.business_id IS DISTINCT FROM v_match.business_id) THEN
    RAISE EXCEPTION 'Write-off account belongs to a different organization/company';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_recon_writeoffs_validate_scope ON public.bank_reconciliation_writeoffs;
CREATE TRIGGER trg_bank_recon_writeoffs_validate_scope
  BEFORE INSERT OR UPDATE OF reconciliation_match_id, account_id
  ON public.bank_reconciliation_writeoffs
  FOR EACH ROW EXECUTE FUNCTION public.validate_bank_reconciliation_writeoff_scope();

-- Replace blind direct posting with durable rule suggestions by default.
CREATE OR REPLACE FUNCTION public.apply_reconciliation_rules(
  _bank_account_id uuid,
  _user_id uuid DEFAULT NULL,
  _max_rows integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ba record;
  _txn record;
  _rule record;
  _matched_count integer := 0;
  _processed integer := 0;
  _residual numeric;
BEGIN
  SELECT * INTO _ba FROM public.bank_accounts WHERE id = _bank_account_id;
  IF _ba IS NULL THEN
    RAISE EXCEPTION 'Bank account % not found', _bank_account_id;
  END IF;

  FOR _txn IN
    SELECT *
    FROM public.bank_transactions
    WHERE bank_account_id = _bank_account_id
      AND business_id = _ba.business_id
      AND COALESCE(is_reconciled, false) = false
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
      AND (r.description_pattern IS NULL OR COALESCE(_txn.description, '') ILIKE r.description_pattern)
      AND (r.description_regex IS NULL OR COALESCE(_txn.description, '') ~* r.description_regex)
      AND (r.reference_pattern IS NULL OR COALESCE(_txn.reference, '') ILIKE r.reference_pattern)
    ORDER BY r.priority ASC, r.created_at ASC
    LIMIT 1;

    CONTINUE WHEN _rule IS NULL;

    _residual := 0;

    INSERT INTO public.bank_reconciliation_matches (
      organization_id, business_id, branch_id, bank_transaction_id,
      matched_entity_type, matched_entity_id, matched_amount, residual_amount,
      match_type, status, confidence, rule_id, notes, created_by
    ) VALUES (
      _ba.organization_id, _ba.business_id, _ba.branch_id, _txn.id,
      'account', _rule.counterpart_account_id, ABS(_txn.amount), _residual,
      CASE WHEN _rule.auto_post THEN 'rule' ELSE 'suggestion' END,
      CASE WHEN _rule.auto_post THEN 'to_check' ELSE 'suggested' END,
      CASE WHEN _rule.auto_post THEN 0.95 ELSE 0.80 END,
      _rule.id,
      COALESCE(_rule.description_template, _txn.description, _rule.name),
      _user_id
    )
    ON CONFLICT DO NOTHING;

    UPDATE public.bank_transactions
       SET match_source = 'rule:' || _rule.name,
           match_confidence = CASE WHEN _rule.auto_post THEN 0.95 ELSE 0.80 END,
           reconciled_type = CASE WHEN _rule.auto_post THEN 'to_check' ELSE reconciled_type END,
           updated_at = now()
     WHERE id = _txn.id;

    UPDATE public.bank_reconciliation_rules
       SET match_count = match_count + 1,
           last_matched_at = now()
     WHERE id = _rule.id;

    _matched_count := _matched_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', _processed, 'matched', _matched_count, 'mode', 'suggestions');
END;
$$;

REVOKE ALL ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.apply_reconciliation_rules(uuid, uuid, integer) TO authenticated;

-- 4) FX revaluation: explicit reversal policy and journal book linkage.
ALTER TABLE public.fx_revaluation_runs
  ADD COLUMN IF NOT EXISTS reversal_policy text NOT NULL DEFAULT 'next_period' CHECK (reversal_policy IN ('none','next_period','next_run')),
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.revalue_fx_balances(
  _business_id uuid,
  _run_date date,
  _base_currency text,
  _unrealized_gain_account uuid,
  _unrealized_loss_account uuid,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _run_id uuid;
  _je_id uuid;
  _je_number text;
  _fx_book_id uuid;
  _row record;
  _new_rate numeric;
  _line_seq integer := 0;
  _total_gain numeric := 0;
  _total_loss numeric := 0;
  _net_delta numeric := 0;
  _base_new numeric;
  _delta numeric;
  _old_rate numeric;
BEGIN
  SELECT organization_id INTO _org_id FROM public.businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  SELECT public.default_journal_book_for_source(_business_id, 'fx_revaluation') INTO _fx_book_id;

  INSERT INTO public.fx_revaluation_runs (
    organization_id, business_id, run_date, base_currency, status, created_by, reversal_policy
  ) VALUES (
    _org_id, _business_id, _run_date, _base_currency, 'draft', _user_id, 'next_period'
  ) RETURNING id INTO _run_id;

  _je_number := 'FX-' || to_char(_run_date, 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);

  INSERT INTO public.journal_entries (
    organization_id, business_id, entry_number, entry_date, description,
    status, source_type, source_id, posted_at, posted_by, created_by,
    is_adjusting, is_adjusting_entry, total_debit, total_credit, journal_book_id
  ) VALUES (
    _org_id, _business_id, _je_number, _run_date,
    'Unrealized FX revaluation as of ' || _run_date,
    'draft', 'fx_revaluation', _run_id, NULL, NULL, _user_id,
    true, true, 0, 0, _fx_book_id
  ) RETURNING id INTO _je_id;

  FOR _row IN
    SELECT
      jel.account_id,
      je.currency,
      SUM(COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) AS foreign_balance,
      SUM((COALESCE(jel.debit,0) - COALESCE(jel.credit,0)) * COALESCE(je.exchange_rate,1)) AS base_balance_old
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    WHERE je.business_id = _business_id
      AND je.status = 'posted'
      AND je.entry_date <= _run_date
      AND je.currency IS NOT NULL
      AND je.currency <> _base_currency
      AND a.account_type IN ('asset','liability')
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
    _delta := _base_new - _row.base_balance_old;
    _old_rate := CASE WHEN _row.foreign_balance = 0 THEN _new_rate ELSE _row.base_balance_old / _row.foreign_balance END;

    INSERT INTO public.fx_revaluation_lines (
      run_id, account_id, currency, foreign_balance,
      old_rate, new_rate, base_balance_old, base_balance_new, delta
    ) VALUES (
      _run_id, _row.account_id, _row.currency, _row.foreign_balance,
      _old_rate, _new_rate, _row.base_balance_old, _base_new, _delta
    );

    CONTINUE WHEN ABS(_delta) < 0.01;

    IF _delta > 0 THEN
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (_je_id, _row.account_id, 'FX reval ' || _row.currency || ' @ ' || _new_rate, _delta, 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (_je_id, _unrealized_gain_account, 'FX reval ' || _row.currency || ' @ ' || _new_rate, 0, _delta, _line_seq);
      _line_seq := _line_seq + 1;
      _total_gain := _total_gain + _delta;
    ELSE
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (_je_id, _unrealized_loss_account, 'FX reval ' || _row.currency || ' @ ' || _new_rate, ABS(_delta), 0, _line_seq);
      _line_seq := _line_seq + 1;
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
      VALUES (_je_id, _row.account_id, 'FX reval ' || _row.currency || ' @ ' || _new_rate, 0, ABS(_delta), _line_seq);
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
         total_debit = (SELECT COALESCE(SUM(debit),0) FROM public.journal_entry_lines WHERE journal_entry_id = _je_id),
         total_credit = (SELECT COALESCE(SUM(credit),0) FROM public.journal_entry_lines WHERE journal_entry_id = _je_id)
   WHERE id = _je_id;

  UPDATE public.fx_revaluation_runs
     SET status = 'posted',
         total_unrealized_gain = _total_gain,
         total_unrealized_loss = _total_loss,
         journal_entry_id = _je_id
   WHERE id = _run_id;

  RETURN jsonb_build_object(
    'success', true,
    'run_id', _run_id,
    'journal_entry_id', _je_id,
    'lines', _line_seq,
    'unrealized_gain', _total_gain,
    'unrealized_loss', _total_loss,
    'net_delta', _net_delta,
    'reversal_policy', 'next_period'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revalue_fx_balances(uuid, date, text, uuid, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.revalue_fx_balances(uuid, date, text, uuid, uuid, uuid) TO authenticated;

-- 5) Extend integrity findings to the new reconciliation trail and canonical taxonomy.
CREATE OR REPLACE VIEW public.accounting_integrity_findings
WITH (security_invoker = true) AS
WITH line_totals AS (
  SELECT je.id AS journal_entry_id, COUNT(jel.id) AS line_count,
         COALESCE(SUM(jel.debit), 0)::numeric AS debit_total,
         COALESCE(SUM(jel.credit), 0)::numeric AS credit_total
  FROM public.journal_entries je
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY je.id
), ledger_balances AS (
  SELECT a.id AS account_id,
         SUM(CASE WHEN a.account_type IN ('asset', 'expense') THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
                  ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0) END)::numeric AS ledger_balance
  FROM public.accounts a
  LEFT JOIN public.journal_entry_lines jel ON jel.account_id = a.id
  LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
  GROUP BY a.id
)
SELECT gen_random_uuid() AS id, je.organization_id, je.business_id, je.branch_id,
  'critical'::text AS severity, 'journal_entry_unbalanced'::text AS finding_code,
  'Journal entry is not balanced from its posted line totals'::text AS finding_title,
  format('Entry %s has debit %s and credit %s.', je.entry_number, lt.debit_total, lt.credit_total) AS finding_detail,
  'journal_entry'::text AS entity_type, je.id AS entity_id, je.entry_number AS entity_ref,
  jsonb_build_object('debit_total', lt.debit_total, 'credit_total', lt.credit_total, 'line_count', lt.line_count) AS evidence, now() AS detected_at
FROM public.journal_entries je
JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed') AND ABS(COALESCE(lt.debit_total,0) - COALESCE(lt.credit_total,0)) > 0.01
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_entry_insufficient_lines',
  'Journal entry has fewer than two lines', format('Entry %s has %s accounting line(s).', je.entry_number, COALESCE(lt.line_count,0)),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('line_count', COALESCE(lt.line_count,0)), now()
FROM public.journal_entries je JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed') AND COALESCE(lt.line_count,0) < 2
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_line_account_business_mismatch',
  'Journal line uses an account from a different company', format('Entry %s line account %s belongs to a different company.', je.entry_number, a.code),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('account_id', a.id, 'account_business_id', a.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id JOIN public.accounts a ON a.id = jel.account_id
WHERE je.business_id IS NOT NULL AND a.business_id IS NOT NULL AND a.business_id <> je.business_id
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_line_scope_mismatch',
  'Journal line company or branch does not match its parent journal entry', format('Entry %s has at least one line with mismatched company or branch.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('entry_business_id', je.business_id, 'entry_branch_id', je.branch_id, 'line_business_id', jel.business_id, 'line_branch_id', jel.branch_id), now()
FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE jel.business_id IS DISTINCT FROM je.business_id OR jel.branch_id IS DISTINCT FROM je.branch_id
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_branch_business_mismatch',
  'Journal entry branch does not belong to the journal entry company', format('Entry %s is assigned to a branch outside its company.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('branch_id', je.branch_id, 'branch_business_id', br.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entries je JOIN public.branches br ON br.id = je.branch_id
WHERE je.business_id IS NOT NULL AND br.business_id <> je.business_id
UNION ALL
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id, 'critical', 'posted_invoice_missing_journal_entry',
  'Posted customer invoice is not linked to a journal entry', format('Invoice %s is %s but has no linked posted journal entry.', inv.invoice_number, inv.status),
  'invoice', inv.id, inv.invoice_number, jsonb_build_object('status', inv.status, 'journal_entry_id', inv.journal_entry_id), now()
FROM public.invoices inv
LEFT JOIN public.journal_entries je ON je.organization_id = inv.organization_id AND je.source_type = 'invoice' AND je.source_id = inv.id AND je.status <> 'voided'
WHERE inv.status IN ('confirmed','sent','viewed','partial','paid','overdue') AND inv.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id, 'critical', 'invoice_journal_business_branch_mismatch',
  'Invoice journal entry does not match invoice company or branch', format('Invoice %s is linked to a journal entry with inconsistent company or branch.', inv.invoice_number),
  'invoice', inv.id, inv.invoice_number, jsonb_build_object('invoice_business_id', inv.business_id, 'journal_business_id', je.business_id, 'invoice_branch_id', inv.branch_id, 'journal_branch_id', je.branch_id), now()
FROM public.invoices inv JOIN public.journal_entries je ON je.id = inv.journal_entry_id
WHERE (je.business_id IS DISTINCT FROM inv.business_id OR je.branch_id IS DISTINCT FROM inv.branch_id) AND inv.status IN ('confirmed','sent','viewed','partial','paid','overdue')
UNION ALL
SELECT gen_random_uuid(), b.organization_id, b.business_id, b.branch_id, 'critical', 'posted_bill_missing_journal_entry',
  'Posted vendor bill is not linked to a journal entry', format('Bill %s is %s but has no linked posted journal entry.', b.bill_number, b.status),
  'bill', b.id, b.bill_number, jsonb_build_object('status', b.status, 'journal_entry_id', b.journal_entry_id), now()
FROM public.bills b
LEFT JOIN public.journal_entries je ON je.organization_id = b.organization_id AND je.source_type = 'bill' AND je.source_id = b.id AND je.status <> 'voided'
WHERE b.status IN ('received','partial','paid','overdue') AND b.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), p.organization_id, p.business_id, p.branch_id, 'critical', 'applied_payment_missing_journal_entry',
  'Applied customer payment is not linked to a journal entry', format('Payment %s is applied but has no linked journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text), jsonb_build_object('status', p.status, 'invoice_id', p.invoice_id), now()
FROM public.payments p
LEFT JOIN public.journal_entries je ON je.organization_id = p.organization_id AND je.source_type = 'payment' AND je.source_id = p.id AND je.status <> 'voided'
WHERE COALESCE(p.status, 'applied') = 'applied' AND p.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), bp.organization_id, bp.business_id, bp.branch_id, 'critical', 'bill_payment_missing_journal_entry',
  'Vendor payment is not linked to a journal entry', format('Bill payment %s has no linked journal entry.', bp.id),
  'bill_payment', bp.id, bp.id::text, jsonb_build_object('bill_id', bp.bill_id, 'amount', bp.amount), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je ON je.organization_id = bp.organization_id AND je.source_type = 'bill_payment' AND je.source_id = bp.id AND je.status <> 'voided'
WHERE bp.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), bt.organization_id, bt.business_id, ba.branch_id, 'critical', 'reconciled_bank_transaction_missing_links',
  'Bank transaction is marked reconciled without a durable accounting link', format('Bank transaction %s is reconciled but lacks journal/payment/document/reconciliation-match linkage.', bt.id),
  'bank_transaction', bt.id, COALESCE(bt.reference, bt.id::text), jsonb_build_object('journal_entry_id', bt.journal_entry_id, 'reconciled_payment_id', bt.reconciled_payment_id, 'reconciled_entity_id', bt.reconciled_entity_id, 'match_count', COUNT(m.id)), now()
FROM public.bank_transactions bt
LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
LEFT JOIN public.bank_reconciliation_matches m ON m.bank_transaction_id = bt.id AND m.status IN ('confirmed','to_check')
WHERE COALESCE(bt.is_reconciled, false) = true AND bt.journal_entry_id IS NULL AND bt.reconciled_payment_id IS NULL AND bt.reconciled_entity_id IS NULL
GROUP BY bt.id, bt.organization_id, bt.business_id, ba.branch_id, bt.reference, bt.journal_entry_id, bt.reconciled_payment_id, bt.reconciled_entity_id
HAVING COUNT(m.id) = 0
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'warning', 'posted_journal_entry_missing_journal_book',
  'Posted journal entry is not assigned to a journal book', format('Entry %s is posted without a journal book.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je WHERE je.status = 'posted' AND je.journal_book_id IS NULL
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'warning', 'legacy_bank_rule_direct_gl_posting',
  'Legacy bank reconciliation rule created a direct GL posting', format('Entry %s was created directly by a legacy reconciliation rule; verify it did not bypass suspense/outstanding reconciliation.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je WHERE je.source_type IN ('bank_recon_rule','bank_rule') AND je.status = 'posted'
UNION ALL
SELECT gen_random_uuid(), bt.organization_id, bt.business_id, ba.branch_id, 'warning', 'bank_transaction_has_suggested_match',
  'Bank transaction has a reconciliation suggestion awaiting review', format('Bank transaction %s has suggested reconciliation matches.', COALESCE(bt.reference, bt.id::text)),
  'bank_transaction', bt.id, COALESCE(bt.reference, bt.id::text), jsonb_build_object('suggestions', COUNT(m.id)), now()
FROM public.bank_transactions bt
LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
JOIN public.bank_reconciliation_matches m ON m.bank_transaction_id = bt.id AND m.status IN ('suggested','to_check')
GROUP BY bt.id, bt.organization_id, bt.business_id, ba.branch_id, bt.reference
UNION ALL
SELECT gen_random_uuid(), a.organization_id, a.business_id, NULL::uuid, 'warning', 'account_current_balance_drift',
  'Stored account balance differs from posted ledger balance', format('Account %s %s has stored balance %s but ledger balance %s.', a.code, a.name, COALESCE(a.current_balance,0), COALESCE(lb.ledger_balance,0)),
  'account', a.id, a.code, jsonb_build_object('stored_balance', COALESCE(a.current_balance,0), 'ledger_balance', COALESCE(lb.ledger_balance,0), 'drift', COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)), now()
FROM public.accounts a LEFT JOIN ledger_balances lb ON lb.account_id = a.id
WHERE ABS(COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)) > 0.01;

GRANT SELECT ON public.accounting_integrity_findings TO authenticated;