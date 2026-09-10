CREATE OR REPLACE VIEW public.party_register
WITH (security_invoker = true) AS
SELECT
  c.id,
  c.full_name                                AS name,
  c.full_name                                AS display_name,
  c.phone,
  c.email,
  c.business_id,
  (SELECT b.organization_id FROM public.businesses b WHERE b.id = c.business_id) AS organization_id,
  true                                       AS sms_consent,
  false                                      AS is_company,
  (c.status = 'active')                      AS is_active,
  NULL::text                                 AS company,
  'customer'::text                           AS type,
  NULL::text                                 AS tax_exemption_number,
  NULL::date                                 AS tax_exemption_expiry,
  NULL::uuid                                 AS default_tax_rate_id,
  NULL::uuid                                 AS payment_term_id
FROM public.mf_clients c;

GRANT SELECT ON public.party_register TO authenticated;
GRANT ALL ON public.party_register TO service_role;

DO $$
DECLARE
  r record;
  def text;
  targets text[] := ARRAY[
    'get_general_ledger','get_gl_transactions',
    'finance_partner_ledger','sms_build_doc_vars','rfq_invitations_claim_for_delivery',
    'resolve_rule_recipients','enqueue_sms_event','resolve_line_tax_rate',
    'resolve_payment_term','storage_gc_resolve_objects','upsert_collector_assignment'
  ];
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(targets)
  LOOP
    def := pg_get_functiondef(r.oid);
    def := replace(def, 'public.contacts', 'public.party_register');
    def := regexp_replace(def, '([^.\w])contacts([^\w])', '\1public.party_register\2', 'g');
    EXECUTE def;
  END LOOP;
END $$;