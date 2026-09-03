DROP TRIGGER IF EXISTS trg_bank_transactions_stamp_currency ON public.bank_transactions;
DROP FUNCTION IF EXISTS public._tg_stamp_bank_transaction_currency();
DROP TRIGGER IF EXISTS trg_payroll_match_bank_remittance ON public.bank_transactions;