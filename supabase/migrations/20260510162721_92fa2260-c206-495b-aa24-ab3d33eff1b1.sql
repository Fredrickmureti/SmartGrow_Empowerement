-- 1. Re-run the idempotent seeder for ALL businesses (top up missing templates)
DO $$
DECLARE b record;
BEGIN
  FOR b IN SELECT id FROM public.businesses LOOP
    PERFORM public.seed_pos_payment_methods(b.id);
  END LOOP;
END $$;

-- 2. Add match_reason column to mpesa_c2b_transactions
ALTER TABLE public.mpesa_c2b_transactions
  ADD COLUMN IF NOT EXISTS match_reason text NULL;

COMMENT ON COLUMN public.mpesa_c2b_transactions.match_reason IS
  'Why this C2B receipt was or was not auto-attached: AUTO_INVOICE, AUTO_POS, NO_OPEN_SALE, AMBIGUOUS_CANDIDATES, NO_BILL_REF';

CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_unreconciled_lookup
  ON public.mpesa_c2b_transactions (organization_id, is_reconciled, trans_time DESC);