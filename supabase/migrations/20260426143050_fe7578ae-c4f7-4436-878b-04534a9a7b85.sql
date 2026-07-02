
-- 1. Reverse balance impact on the two affected accounts.
UPDATE public.accounts SET current_balance = COALESCE(current_balance,0) - 100000, updated_at = now()
 WHERE id = 'acc2178b-0373-4a2c-9554-dcfd006938c3';
UPDATE public.accounts SET current_balance = COALESCE(current_balance,0) + 100000, updated_at = now()
 WHERE id = '355fbf2a-4cfc-4739-a938-2169ac66f7d6';

-- 2. Disable immutability triggers for this surgical admin purge only.
ALTER TABLE public.journal_entries      DISABLE TRIGGER USER;
ALTER TABLE public.journal_entry_lines  DISABLE TRIGGER USER;

DELETE FROM public.journal_entry_lines WHERE journal_entry_id = '3c7d244d-bfa7-4896-b55c-1194ded47857';
DELETE FROM public.journal_entries     WHERE id              = '3c7d244d-bfa7-4896-b55c-1194ded47857';

-- 3. Re-arm all immutability triggers immediately.
ALTER TABLE public.journal_entries      ENABLE TRIGGER USER;
ALTER TABLE public.journal_entry_lines  ENABLE TRIGGER USER;

-- 4. Permanent safeguard — strict source_type → account_type matrix.
CREATE OR REPLACE FUNCTION public.validate_business_txn_account_types()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source_type text;
  v_debit_types text[];
  v_credit_types text[];
BEGIN
  SELECT je.source_type,
         array_agg(DISTINCT a.account_type::text) FILTER (WHERE jel.debit  > 0),
         array_agg(DISTINCT a.account_type::text) FILTER (WHERE jel.credit > 0)
    INTO v_source_type, v_debit_types, v_credit_types
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN public.accounts a ON a.id = jel.account_id
   WHERE je.id = NEW.journal_entry_id
   GROUP BY je.source_type;

  IF v_source_type IS NULL THEN RETURN NEW; END IF;

  IF v_source_type = 'owner_investment' THEN
    IF NOT (v_debit_types <@ ARRAY['asset'] AND v_credit_types <@ ARRAY['equity']) THEN
      RAISE EXCEPTION 'owner_investment must DEBIT asset and CREDIT equity. Got debit=%, credit=%', v_debit_types, v_credit_types USING ERRCODE='check_violation';
    END IF;
  ELSIF v_source_type = 'owner_drawing' THEN
    IF NOT (v_debit_types <@ ARRAY['equity'] AND v_credit_types <@ ARRAY['asset']) THEN
      RAISE EXCEPTION 'owner_drawing must DEBIT equity and CREDIT asset. Got debit=%, credit=%', v_debit_types, v_credit_types USING ERRCODE='check_violation';
    END IF;
  ELSIF v_source_type = 'bank_transfer' THEN
    IF NOT (v_debit_types <@ ARRAY['asset'] AND v_credit_types <@ ARRAY['asset']) THEN
      RAISE EXCEPTION 'bank_transfer must move Asset→Asset. Got debit=%, credit=%', v_debit_types, v_credit_types USING ERRCODE='check_violation';
    END IF;
  ELSIF v_source_type = 'loan_received' THEN
    IF NOT (v_debit_types <@ ARRAY['asset'] AND v_credit_types <@ ARRAY['liability']) THEN
      RAISE EXCEPTION 'loan_received must DEBIT asset and CREDIT liability. Got debit=%, credit=%', v_debit_types, v_credit_types USING ERRCODE='check_violation';
    END IF;
  ELSIF v_source_type = 'loan_repayment' THEN
    IF NOT (v_debit_types <@ ARRAY['liability','expense'] AND v_credit_types <@ ARRAY['asset']) THEN
      RAISE EXCEPTION 'loan_repayment must DEBIT liability/expense and CREDIT asset. Got debit=%, credit=%', v_debit_types, v_credit_types USING ERRCODE='check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_business_txn_account_types ON public.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_validate_business_txn_account_types
AFTER INSERT ON public.journal_entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_business_txn_account_types();
