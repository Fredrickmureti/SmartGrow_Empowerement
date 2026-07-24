-- Phase C.1: garnishment sub-ledger enablement
-- 1) Extend legal_orders view with the canonical Party-spine columns.
DROP VIEW IF EXISTS public.legal_orders;
CREATE VIEW public.legal_orders
WITH (security_invoker = true) AS
SELECT
  g.id                        AS id,
  g.organization_id,
  g.business_id,
  g.employee_id,
  g.employment_id,
  g.kind                      AS kind_code,
  g.priority,
  g.case_reference,
  g.authority_id,
  g.authority_contact_id,
  g.recipient_contact_id,
  g.cap_rule,
  g.fixed_amount,
  g.percent_of_disposable,
  g.total_owed,
  g.total_paid,
  g.total_accrued,
  g.start_date,
  g.end_date,
  g.is_active,
  g.aggregate_cap_exempt,
  g.minimum_take_home_amount,
  g.status,
  g.status_changed_at,
  g.status_changed_by,
  g.status_reason,
  g.payee_name,
  g.payee_bank,
  g.payee_account,
  g.payee_reference,
  g.payee_contact_id,
  g.payee_payment_method_id,
  g.payee_unmapped,
  g.document_url,
  g.document_filename,
  g.notes,
  g.created_by,
  g.created_at,
  g.updated_at,
  d.calc_model,
  d.priority_class,
  d.protected_earnings_rule,
  d.aggregate_cap_membership,
  d.remittance_schedule_ref,
  d.evidence_requirements,
  d.completion_rule,
  d.reporting_binding_ref,
  d.source_pack_id             AS legal_behavior_pack_id,
  g.recipient_id,
  r.display_name               AS recipient_name,
  r.recipient_type_code        AS recipient_type,
  r.jurisdiction_country       AS recipient_jurisdiction_country,
  r.jurisdiction_region        AS recipient_jurisdiction_region,
  r.always_first               AS recipient_always_first_default,
  r.aggregate_cap_exempt       AS recipient_cap_exempt_default
FROM public.legal_orders_records g
LEFT JOIN public.garnishment_kind_defaults d
  ON d.organization_id = g.organization_id
 AND d.kind = g.kind::text
LEFT JOIN public.legal_recipients r
  ON r.id = g.recipient_id;

GRANT SELECT ON public.legal_orders TO authenticated;

COMMENT ON VIEW public.legal_orders IS
'Enterprise read model for legal orders. Post-Phase-A: recipient_contact_id and authority_contact_id are the canonical Party-spine keys; payee_* fields remain for legacy readers during the transition and are scheduled for retirement in Phase E.';

-- 2) Canonical resolver used by accounting/remittance code to pin a legal
--    order to a single Recipient Contact (partner) for sub-ledger posting.
--    Prefers Phase-A recipient_contact_id, falls back to legacy links.
CREATE OR REPLACE FUNCTION public.garnishment_recipient_contact_for_order(
  p_order_id uuid
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    o.recipient_contact_id,
    o.payee_contact_id,
    r.contact_id
  )
  FROM public.legal_orders_records o
  LEFT JOIN public.legal_recipients r ON r.id = o.recipient_id
  WHERE o.id = p_order_id
$$;

GRANT EXECUTE ON FUNCTION public.garnishment_recipient_contact_for_order(uuid)
  TO authenticated, service_role;

-- 3) Sub-ledger read performance: partial index on non-null contact_id.
CREATE INDEX IF NOT EXISTS journal_entry_lines_contact_id_partial_idx
  ON public.journal_entry_lines(contact_id)
  WHERE contact_id IS NOT NULL;
