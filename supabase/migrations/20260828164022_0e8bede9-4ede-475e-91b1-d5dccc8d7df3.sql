-- Two defects, both of which made a posted revaluation invisible:
--
-- 1. The revaluation adjustment is posted in the base currency, so it fell
--    outside this function's foreign-currency filter. The exposure therefore
--    still read as carried at the old rate and the same difference would be
--    recognised again on every run.
-- 2. Exposure was measured per account only. An intercompany receivable is
--    matched to its counterparty by contact, so an untagged adjustment never
--    reached the balance the consolidation engine compares.
DROP FUNCTION IF EXISTS public.fx_open_monetary_positions(uuid, date);

CREATE FUNCTION public.fx_open_monetary_positions(_business_id uuid, _as_of date)
RETURNS TABLE(account_id uuid, contact_id uuid, currency text, foreign_balance numeric, base_balance_old numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH lines AS (
    SELECT jel.account_id,
           jel.contact_id,
           upper(COALESCE(jel.original_currency, je.currency)) AS cur,
           upper(b.base_currency)                              AS base_cur,
           COALESCE(jel.original_debit, jel.debit, 0)
             - COALESCE(jel.original_credit, jel.credit, 0)     AS fx_amount,
           COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)     AS base_amount,
           je.source_type
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.accounts a ON a.id = jel.account_id
      JOIN public.businesses b ON b.id = je.business_id
     WHERE je.business_id = _business_id
       AND je.status = 'posted'
       AND je.entry_date <= _as_of
       AND COALESCE(jel.original_currency, je.currency) IS NOT NULL
       AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text)
  ),
  positions AS (
    SELECT l.account_id,
           l.contact_id,
           l.cur,
           SUM(l.fx_amount)   AS foreign_balance,
           SUM(l.base_amount) AS base_balance,
           COUNT(*) OVER (PARTITION BY l.account_id, l.contact_id) AS currencies_on_position
      FROM lines l
     WHERE l.cur <> l.base_cur
     GROUP BY l.account_id, l.contact_id, l.cur
  ),
  -- Base-currency retranslation already recognised on the same account and
  -- counterparty. Restricted to this engine's own entries, so ordinary
  -- base-currency activity is never folded into a foreign exposure.
  recognised AS (
    SELECT l.account_id, l.contact_id, SUM(l.base_amount) AS base_amount
      FROM lines l
     WHERE l.cur = l.base_cur
       AND l.source_type IN ('fx_revaluation', 'fx_revaluation_reversal')
     GROUP BY l.account_id, l.contact_id
  )
  SELECT p.account_id,
         p.contact_id,
         p.cur,
         p.foreign_balance,
         p.base_balance
           -- Only an unambiguous single-currency position can absorb the
           -- recognised adjustment; a mixed-currency position is left as-is
           -- rather than guessed at.
           + CASE WHEN p.currencies_on_position = 1 THEN COALESCE(r.base_amount, 0) ELSE 0 END
    FROM positions p
    LEFT JOIN recognised r
      ON r.account_id = p.account_id
     AND r.contact_id IS NOT DISTINCT FROM p.contact_id
   WHERE ABS(p.foreign_balance) > 0.01
$function$;

REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.fx_open_monetary_positions(uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fx_open_monetary_positions(uuid, date) TO service_role;