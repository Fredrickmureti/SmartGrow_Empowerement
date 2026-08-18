CREATE OR REPLACE FUNCTION public.bank_account_reset_opening_balances(_business_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record; n integer := 0;
BEGIN
  PERFORM public.assert_can_manage_bank_accounts(_business_id);

  FOR r IN SELECT id, opening_balance_je_id FROM public.bank_accounts
            WHERE business_id = _business_id
              AND (COALESCE(opening_balance,0) <> 0 OR opening_balance_je_id IS NOT NULL)
            FOR UPDATE
  LOOP
    -- Never orphan the ledger: reverse the posted entry through the engine.
    IF r.opening_balance_je_id IS NOT NULL THEN
      PERFORM public.void_journal_entry_atomic(
        r.opening_balance_je_id, 'Migration reset of bank opening balance', auth.uid(), NULL, NULL);
    END IF;
    UPDATE public.bank_accounts
       SET opening_balance = 0, opening_balance_je_id = NULL, updated_at = now()
     WHERE id = r.id;
    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bank_account_reset_opening_balances(uuid) TO authenticated;

INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description)
VALUES ('banking.account', 'banking', ARRAY['finance']::text[],
        'Bank account lifecycle and opening-balance events')
ON CONFLICT DO NOTHING;