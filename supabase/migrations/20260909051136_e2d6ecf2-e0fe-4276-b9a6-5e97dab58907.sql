CREATE OR REPLACE FUNCTION public.mf_loan_events_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Loan events are append-only';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.mf_collection_bankings_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_old_line_status text;
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Collection bankings are append-only';
  END IF;

  IF NEW.id                  IS DISTINCT FROM OLD.id
  OR NEW.business_id         IS DISTINCT FROM OLD.business_id
  OR NEW.branch_id           IS DISTINCT FROM OLD.branch_id
  OR NEW.batch_id            IS DISTINCT FROM OLD.batch_id
  OR NEW.bank_account_id     IS DISTINCT FROM OLD.bank_account_id
  OR NEW.banked_on           IS DISTINCT FROM OLD.banked_on
  OR NEW.amount              IS DISTINCT FROM OLD.amount
  OR NEW.cash_amount         IS DISTINCT FROM OLD.cash_amount
  OR NEW.mobile_money_amount IS DISTINCT FROM OLD.mobile_money_amount
  OR NEW.reference           IS DISTINCT FROM OLD.reference
  OR NEW.notes               IS DISTINCT FROM OLD.notes
  OR NEW.journal_entry_id    IS DISTINCT FROM OLD.journal_entry_id
  OR NEW.banked_by           IS DISTINCT FROM OLD.banked_by
  OR NEW.created_at          IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Collection bankings are append-only: only the confirming bank statement line may be recorded';
  END IF;

  IF OLD.bank_transaction_id IS NOT NULL
     AND NEW.bank_transaction_id IS DISTINCT FROM OLD.bank_transaction_id THEN
    SELECT bt.lifecycle_status INTO v_old_line_status
    FROM public.bank_transactions bt
    WHERE bt.id = OLD.bank_transaction_id;
    IF v_old_line_status IS DISTINCT FROM 'excluded' OR NEW.bank_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'This banking is already confirmed against a bank statement line';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;