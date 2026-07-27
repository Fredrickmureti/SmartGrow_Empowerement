
-- Wave 1: Document Domain foundation
-- Introduces the canonical Document aggregate + document_kinds registry,
-- and augments document_artifacts with the columns the new pipeline requires.
-- No renderer, UI, or policy changes in this migration — spine only.

-- 1) document_kinds registry (code-owned; seeded below).
CREATE TABLE IF NOT EXISTS public.document_kinds (
  code text PRIMARY KEY,
  label text NOT NULL,
  domain text NOT NULL,                -- sales | pos | purchases | inventory | wms | manufacturing | hr | payroll | finance | legal
  legal_class text NOT NULL DEFAULT 'none',   -- none | fiscal | statutory | contractual
  default_media_class text NOT NULL DEFAULT 'a4_portrait',
  default_intents text[] NOT NULL DEFAULT ARRAY['view','download','print']::text[],
  allowed_formats text[] NOT NULL DEFAULT ARRAY['pdf']::text[],   -- pdf | escpos | zpl | epl | html | csv
  requires_party boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.document_kinds TO anon, authenticated;
GRANT ALL ON public.document_kinds TO service_role;
ALTER TABLE public.document_kinds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_kinds readable to all"
  ON public.document_kinds FOR SELECT
  USING (true);

-- 2) documents aggregate.
CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid,
  branch_id uuid,
  kind_code text NOT NULL REFERENCES public.document_kinds(code),
  version int NOT NULL DEFAULT 1,
  source_module text NOT NULL,          -- 'sales' | 'pos' | 'purchases' | ...
  source_doc_type text,                 -- 'invoice' | 'delivery_note' | 'payslip' | ...
  source_doc_id uuid,                   -- primary key of the originating business row
  source_event_id uuid,                 -- domain event / business_event_outbox id when known
  party_kind text,                      -- 'customer' | 'vendor' | 'employee' | null
  party_id uuid,
  currency text,
  locale text,
  status text NOT NULL DEFAULT 'issued',    -- draft | issued | superseded | voided
  superseded_by uuid REFERENCES public.documents(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_org_kind_created_idx
  ON public.documents (organization_id, kind_code, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_source_idx
  ON public.documents (source_module, source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS documents_party_idx
  ON public.documents (party_kind, party_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Org-scoped access via user_organizations membership (pattern used elsewhere in the codebase).
CREATE POLICY "documents readable by org members"
  ON public.documents FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "documents writable by org members"
  ON public.documents FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "documents updatable by org members"
  ON public.documents FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "documents deletable by org members"
  ON public.documents FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

-- 3) document_artifacts v2 columns (backwards-compatible additions).
ALTER TABLE public.document_artifacts
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES public.documents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS media_class text,          -- a4_portrait | a5_landscape | thermal_80 | label_4x6 | ...
  ADD COLUMN IF NOT EXISTS format text,               -- pdf | escpos | zpl | epl | html | csv
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'standard',   -- standard | fiscal_7y | statutory_10y | permanent
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.document_artifacts(id);

CREATE INDEX IF NOT EXISTS document_artifacts_document_id_idx
  ON public.document_artifacts (document_id);
CREATE INDEX IF NOT EXISTS document_artifacts_content_hash_idx
  ON public.document_artifacts (content_hash);

-- 4) Timestamp trigger reuse.
CREATE OR REPLACE FUNCTION public.documents_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS documents_touch_updated_at ON public.documents;
CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_touch_updated_at();

DROP TRIGGER IF EXISTS document_kinds_touch_updated_at ON public.document_kinds;
CREATE TRIGGER document_kinds_touch_updated_at
  BEFORE UPDATE ON public.document_kinds
  FOR EACH ROW EXECUTE FUNCTION public.documents_touch_updated_at();

-- 5) Seed the canonical kind registry (Wave 1 §1.1 of the plan).
INSERT INTO public.document_kinds (code, label, domain, legal_class, default_media_class, default_intents, allowed_formats, requires_party) VALUES
  ('sales.estimate',        'Estimate',                'sales',        'none',        'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf','html'], true),
  ('sales.proforma',        'Proforma Invoice',        'sales',        'none',        'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf','html'], true),
  ('sales.order_ack',       'Sales Order Acknowledgement','sales',     'contractual', 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],        true),
  ('sales.delivery_note',   'Delivery Note',           'sales',        'contractual', 'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf','escpos'], true),
  ('sales.packing_list',    'Packing List',            'sales',        'none',        'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf'],          true),
  ('sales.invoice',         'Tax Invoice',             'sales',        'fiscal',      'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf','escpos'], true),
  ('sales.credit_note',     'Credit Note',             'sales',        'fiscal',      'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf','escpos'], true),
  ('sales.debit_note',      'Debit Note',              'sales',        'fiscal',      'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],          true),
  ('sales.payment_receipt', 'Payment Receipt',         'sales',        'fiscal',      'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf','escpos'], true),
  ('sales.statement',       'Customer Statement',      'sales',        'none',        'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf','csv'],    true),
  ('pos.receipt_customer',  'POS Customer Receipt',    'pos',          'fiscal',      'thermal_80',  ARRAY['view','print'],                    ARRAY['escpos','pdf'], false),
  ('pos.receipt_merchant',  'POS Merchant Copy',       'pos',          'none',        'thermal_80',  ARRAY['print'],                           ARRAY['escpos'],       false),
  ('pos.kitchen_ticket',    'Kitchen Ticket',          'pos',          'none',        'thermal_80',  ARRAY['print'],                           ARRAY['escpos'],       false),
  ('purchases.po',          'Purchase Order',          'purchases',    'contractual', 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],          true),
  ('purchases.bill',        'Vendor Bill',             'purchases',    'none',        'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf'],          true),
  ('inventory.grn',         'Goods Receipt Note',      'inventory',    'contractual', 'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf'],          true),
  ('inventory.putaway_list','Putaway List',            'wms',          'none',        'a4_portrait', ARRAY['view','print'],                    ARRAY['pdf'],          false),
  ('inventory.pallet_label','Pallet Label',            'wms',          'none',        'label_4x6',   ARRAY['print'],                           ARRAY['zpl','epl'],    false),
  ('inventory.pick_list',   'Pick List',               'wms',          'none',        'a4_portrait', ARRAY['view','print'],                    ARRAY['pdf'],          false),
  ('inventory.packing_slip','Packing Slip',            'wms',          'contractual', 'a4_portrait', ARRAY['view','print'],                    ARRAY['pdf'],          true),
  ('inventory.shipping_label','Shipping Label',        'wms',          'contractual', 'label_4x6',   ARRAY['print'],                           ARRAY['zpl','epl','pdf'], true),
  ('inventory.shelf_label', 'Shelf Label',             'inventory',    'none',        'label_50x30', ARRAY['print'],                           ARRAY['zpl','epl'],    false),
  ('inventory.price_label', 'Price Label',             'inventory',    'none',        'label_50x30', ARRAY['print'],                           ARRAY['zpl','epl'],    false),
  ('inventory.item_barcode','Item Barcode',            'inventory',    'none',        'label_50x30', ARRAY['print'],                           ARRAY['zpl','epl'],    false),
  ('mfg.work_order',        'Work Order',              'manufacturing','none',        'a4_portrait', ARRAY['view','print'],                    ARRAY['pdf'],          false),
  ('mfg.route_card',        'Route Card',              'manufacturing','none',        'a4_portrait', ARRAY['view','print'],                    ARRAY['pdf'],          false),
  ('mfg.fg_label',          'Finished Goods Label',    'manufacturing','none',        'label_4x6',   ARRAY['print'],                           ARRAY['zpl','epl'],    false),
  ('hr.offer_letter',       'Offer Letter',            'hr',           'contractual', 'a4_portrait', ARRAY['view','download','email','sign'],  ARRAY['pdf'],          true),
  ('hr.contract',           'Employment Contract',     'hr',           'contractual', 'a4_portrait', ARRAY['view','download','email','sign'],  ARRAY['pdf'],          true),
  ('hr.employment_letter',  'Employment Letter',       'hr',           'contractual', 'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf'],          true),
  ('hr.certificate',        'HR Certificate',          'hr',           'contractual', 'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf'],          true),
  ('payroll.payslip',       'Payslip',                 'payroll',      'statutory',   'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],          true),
  ('payroll.bank_file',     'Payroll Bank File',       'payroll',      'statutory',   'a4_portrait', ARRAY['download'],                        ARRAY['csv'],          false),
  ('payroll.statutory_return','Statutory Return',      'payroll',      'statutory',   'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf','csv'],    false),
  ('payroll.tax_certificate','Tax Certificate',        'payroll',      'statutory',   'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf'],          true),
  ('payroll.annual_earnings','Annual Earnings Statement','payroll',    'statutory',   'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf'],          true),
  ('finance.journal',       'Journal Report',          'finance',      'statutory',   'a4_portrait', ARRAY['view','download'],                 ARRAY['pdf','csv'],    false),
  ('finance.trial_balance', 'Trial Balance',           'finance',      'statutory',   'a4_portrait', ARRAY['view','download'],                 ARRAY['pdf','csv'],    false),
  ('finance.statements',    'Financial Statements',    'finance',      'statutory',   'a4_portrait', ARRAY['view','download'],                 ARRAY['pdf'],          false),
  ('legal.remittance_advice','Remittance Advice',      'legal',        'statutory',   'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf'],          true),
  ('legal.fiscal_receipt',  'Fiscal Receipt (QR)',     'legal',        'fiscal',      'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf','escpos'], true)
ON CONFLICT (code) DO NOTHING;
