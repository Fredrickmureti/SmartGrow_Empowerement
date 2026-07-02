-- Fix payment method keys to match pos_transaction_payments check constraint
-- The constraint expects: cash, card, mobile_money, voucher, credit, bank_transfer, other

-- Update 'mobile' to 'mobile_money'
UPDATE pos_payment_methods 
SET method_key = 'mobile_money' 
WHERE method_key = 'mobile';

-- Update 'store_credit' to 'credit'
UPDATE pos_payment_methods 
SET method_key = 'credit' 
WHERE method_key = 'store_credit';

-- Update 'check' to 'voucher'
UPDATE pos_payment_methods 
SET method_key = 'voucher' 
WHERE method_key = 'check';