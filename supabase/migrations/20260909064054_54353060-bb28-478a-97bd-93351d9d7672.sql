CREATE OR REPLACE VIEW public.mf_client_fee_positions
WITH (security_invoker = true) AS
SELECT
  c.id                AS client_id,
  c.business_id,
  c.branch_id,
  c.client_number,
  c.full_name,
  gm.group_id,
  ch.id               AS charge_id,
  ch.kind,
  ch.charged_on,
  ch.currency_code,
  COALESCE(ch.amount, 0)                                   AS fee_amount,
  COALESCE(ch.paid_amount, 0)                              AS paid_amount,
  GREATEST(COALESCE(ch.amount, 0) - COALESCE(ch.paid_amount, 0), 0) AS outstanding_amount,
  COALESCE(ch.status, 'none')                              AS charge_status,
  lastp.collection_id AS last_collection_id,
  lastp.paid_on       AS last_paid_on
FROM public.mf_clients c
LEFT JOIN public.mf_group_members gm
       ON gm.client_id = c.id AND gm.is_active
LEFT JOIN public.mf_client_charges ch
       ON ch.client_id = c.id AND ch.kind = 'admission_fee' AND ch.status <> 'reversed'
LEFT JOIN LATERAL (
  SELECT p.collection_id, p.paid_on
    FROM public.mf_client_charge_payments p
   WHERE p.charge_id = ch.id AND p.status = 'posted'
   ORDER BY p.paid_on DESC, p.created_at DESC
   LIMIT 1
) lastp ON true;

COMMENT ON VIEW public.mf_client_fee_positions IS
  'Authoritative fee position per client: what is owed, what is paid, what remains, and which collection last settled them. Never maintain a paid flag by hand.';

GRANT SELECT ON public.mf_client_fee_positions TO authenticated;