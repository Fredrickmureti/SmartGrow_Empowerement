
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bills','bill_payments','payments','journal_entries',
    'purchase_orders','expenses','customer_refunds',
    'vendor_credit_notes','credit_notes',
    'employee_compensation_history','employee_contracts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS approved_by   uuid', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS approved_at   timestamptz', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS submitted_by  uuid', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS submitted_at  timestamptz', t);
  END LOOP;
END$$;
