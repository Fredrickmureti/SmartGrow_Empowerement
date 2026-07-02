-- Backfill pos_transaction_items.business_id from parent transaction
UPDATE public.pos_transaction_items i
SET business_id = t.business_id
FROM public.pos_transactions t
WHERE i.transaction_id = t.id
  AND i.business_id IS NULL
  AND t.business_id IS NOT NULL;

-- Backfill pos_transaction_payments.business_id from parent transaction
UPDATE public.pos_transaction_payments p
SET business_id = t.business_id
FROM public.pos_transactions t
WHERE p.transaction_id = t.id
  AND p.business_id IS NULL
  AND t.business_id IS NOT NULL;

-- Backfill pos_cashier_registers.business_id from register
UPDATE public.pos_cashier_registers cr
SET business_id = r.business_id
FROM public.pos_registers r
WHERE cr.register_id = r.id
  AND cr.business_id IS NULL
  AND r.business_id IS NOT NULL;

-- Enforce NOT NULL
ALTER TABLE public.pos_transaction_items
  ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.pos_transaction_payments
  ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.pos_cashier_registers
  ALTER COLUMN business_id SET NOT NULL;