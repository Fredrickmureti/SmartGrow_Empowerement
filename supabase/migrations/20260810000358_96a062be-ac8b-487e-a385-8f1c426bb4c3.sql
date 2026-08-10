-- Phase 6.2 — a business may have at most ONE active default payment term.
--
-- resolve_payment_term()'s tier 3 picks the default term with `ORDER BY days`
-- when several exist. That tie-break is silent and arbitrary: two defaults
-- would hand documents a credit period nobody chose — the same class of bug
-- as the retired `businesses.default_payment_terms` integer. Make it
-- impossible rather than resolvable.
CREATE UNIQUE INDEX IF NOT EXISTS payment_terms_one_active_default_per_business
  ON public.payment_terms (business_id)
  WHERE is_default AND is_active;