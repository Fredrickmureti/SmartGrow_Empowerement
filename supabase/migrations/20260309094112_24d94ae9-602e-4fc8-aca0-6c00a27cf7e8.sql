ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cash';

COMMENT ON COLUMN public.expenses.payment_method IS 
'Settlement method: cash, bank, mobile_money, credit_card, petty_cash, payable, employee_reimbursement';