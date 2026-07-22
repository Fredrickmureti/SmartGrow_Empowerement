
-- ═══════════════════════════════════════════════════════════════════════
-- Phase 6a: seed business_event_topics for the legal_order.* fabric
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description, handler_scope, max_attempts)
VALUES
  ('legal_order.submit',                 'payroll', ARRAY['approvals','notifications'],            'Legal order submitted for approval',       'server', 5),
  ('legal_order.approve',                'payroll', ARRAY['notifications','payroll'],              'Legal order approved',                     'server', 5),
  ('legal_order.reject',                 'payroll', ARRAY['notifications'],                        'Legal order rejected',                     'server', 5),
  ('legal_order.activate',               'payroll', ARRAY['payroll','notifications','reporting'],  'Legal order activated for payroll',        'server', 5),
  ('legal_order.suspend',                'payroll', ARRAY['payroll','notifications'],              'Legal order suspended',                    'server', 5),
  ('legal_order.resume',                 'payroll', ARRAY['payroll','notifications'],              'Legal order resumed',                      'server', 5),
  ('legal_order.mark_satisfied',         'payroll', ARRAY['payroll','notifications','reporting'],  'Legal order fully satisfied',              'server', 5),
  ('legal_order.release',                'payroll', ARRAY['payroll','notifications','reporting'],  'Legal order released by authority',        'server', 5),
  ('legal_order.expire',                 'payroll', ARRAY['payroll','notifications'],              'Legal order expired (end_date reached)',   'server', 5),
  ('legal_order.terminate_unsatisfied',  'payroll', ARRAY['payroll','notifications','reporting'],  'Legal order terminated with balance owed', 'server', 5),
  ('legal_order.payment_posted',         'payroll', ARRAY['finance','remittance','reporting'],     'Garnishment line posted from a payslip',   'server', 5)
ON CONFLICT (topic_prefix) DO UPDATE SET
  producer_domain  = EXCLUDED.producer_domain,
  consumer_domains = EXCLUDED.consumer_domains,
  description      = EXCLUDED.description,
  handler_scope    = EXCLUDED.handler_scope,
  max_attempts     = EXCLUDED.max_attempts,
  updated_at       = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 5b-i: legal_order_documents (versioned evidence)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.legal_order_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  garnishment_id   uuid NOT NULL REFERENCES public.employee_garnishments(id) ON DELETE CASCADE,
  version          integer NOT NULL DEFAULT 1,
  document_kind    text NOT NULL DEFAULT 'order',          -- order | amendment | release | other
  storage_bucket   text NOT NULL DEFAULT 'legal-orders',
  storage_path     text NOT NULL,                          -- {org}/{garnishment}/{version}-{filename}
  original_filename text NOT NULL,
  content_type     text,
  byte_size        bigint,
  sha256           text,
  uploaded_by      uuid REFERENCES auth.users(id),
  retention_until  timestamptz,                            -- from pack policy; null = indefinite
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (garnishment_id, version, document_kind)
);

CREATE INDEX IF NOT EXISTS legal_order_documents_garnishment_idx
  ON public.legal_order_documents (garnishment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS legal_order_documents_org_idx
  ON public.legal_order_documents (organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_order_documents TO authenticated;
GRANT ALL ON public.legal_order_documents TO service_role;

ALTER TABLE public.legal_order_documents ENABLE ROW LEVEL SECURITY;

-- Read: any HR-write role for the org (matches employee_garnishments_hr_write)
CREATE POLICY legal_order_documents_read
  ON public.legal_order_documents FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

-- Write: admin/owner/accountant/super_admin only (SoD ceiling — same as HR write policy on parent table)
CREATE POLICY legal_order_documents_write
  ON public.legal_order_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE POLICY legal_order_documents_update
  ON public.legal_order_documents FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  );

CREATE POLICY legal_order_documents_delete
  ON public.legal_order_documents FOR DELETE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  );

COMMENT ON TABLE public.legal_order_documents IS
  'Versioned evidence for legal payroll orders. Files live in the private legal-orders storage bucket; this table is the audited index.';
