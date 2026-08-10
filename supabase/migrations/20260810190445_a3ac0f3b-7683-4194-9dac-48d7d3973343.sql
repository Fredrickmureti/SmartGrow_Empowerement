-- ============================================================
-- RFQ / Sourcing domain — Phase 1: domain model
-- ============================================================

-- ---------- rfqs header ----------
ALTER TABLE public.rfqs
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS required_by_date date,
  ADD COLUMN IF NOT EXISTS deliver_to_warehouse_id uuid REFERENCES public.warehouses(id),
  ADD COLUMN IF NOT EXISTS deliver_to_branch_id uuid REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id),
  ADD COLUMN IF NOT EXISTS requisition_id uuid REFERENCES public.purchase_requisitions(id),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS awarded_by uuid,
  ADD COLUMN IF NOT EXISTS awarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS award_justification text,
  ADD COLUMN IF NOT EXISTS converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

ALTER TABLE public.rfqs DROP CONSTRAINT IF EXISTS rfqs_status_domain;
ALTER TABLE public.rfqs ADD CONSTRAINT rfqs_status_domain CHECK (status IN (
  'draft','pending_approval','approved','sent','responses_received',
  'under_evaluation','awarded','partially_awarded','converted',
  'closed','cancelled','expired'
));

CREATE INDEX IF NOT EXISTS idx_rfqs_requisition ON public.rfqs(requisition_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON public.rfqs(business_id, status);

-- ---------- rfq_items ----------
ALTER TABLE public.rfq_items
  ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

ALTER TABLE public.rfq_items
  ADD COLUMN IF NOT EXISTS uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS need_by_date date,
  ADD COLUMN IF NOT EXISTS requisition_item_id uuid REFERENCES public.purchase_requisition_items(id),
  ADD COLUMN IF NOT EXISTS specification text;

-- ---------- rfq_invitations ----------
CREATE TABLE IF NOT EXISTS public.rfq_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  rfq_version integer NOT NULL DEFAULT 1,
  supplier_id uuid NOT NULL REFERENCES public.contacts(id),
  contact_email text,
  channel text NOT NULL DEFAULT 'email',
  invitation_state text NOT NULL DEFAULT 'pending',
  delivery_state text NOT NULL DEFAULT 'not_sent',
  delivery_error text,
  requested_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  response_deadline timestamptz,
  reminder_count integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_invitations_unique UNIQUE (rfq_id, supplier_id, rfq_version),
  CONSTRAINT rfq_invitations_state_domain CHECK (invitation_state IN
    ('pending','invited','viewed','quoted','declined','no_response','withdrawn','superseded')),
  CONSTRAINT rfq_invitations_delivery_domain CHECK (delivery_state IN
    ('not_sent','queued','sent','delivered','bounced','failed'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfq_invitations TO authenticated;
GRANT ALL ON public.rfq_invitations TO service_role;
ALTER TABLE public.rfq_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY rfq_invitations_staff_all ON public.rfq_invitations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_invitations_portal_select ON public.rfq_invitations
  FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()));

-- ---------- rfq_quotations ----------
CREATE TABLE IF NOT EXISTS public.rfq_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES public.rfq_invitations(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.contacts(id),
  rfq_version integer NOT NULL DEFAULT 1,
  quotation_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'submitted',
  supplier_reference text,
  currency text NOT NULL,
  exchange_rate numeric,
  subtotal numeric NOT NULL DEFAULT 0,
  tax_total numeric NOT NULL DEFAULT 0,
  freight_amount numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  lead_time_days integer,
  incoterms text,
  payment_terms text,
  valid_until date,
  notes text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  submitted_via text NOT NULL DEFAULT 'portal',
  withdrawn_at timestamptz,
  superseded_by uuid REFERENCES public.rfq_quotations(id),
  is_late boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_quotations_version_unique UNIQUE (invitation_id, quotation_version),
  CONSTRAINT rfq_quotations_state_domain CHECK (state IN
    ('submitted','superseded','withdrawn','rejected','awarded','partially_awarded'))
);

CREATE INDEX IF NOT EXISTS idx_rfq_quotations_rfq ON public.rfq_quotations(rfq_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfq_quotations_active
  ON public.rfq_quotations(invitation_id) WHERE state = 'submitted';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfq_quotations TO authenticated;
GRANT ALL ON public.rfq_quotations TO service_role;
ALTER TABLE public.rfq_quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY rfq_quotations_staff_select ON public.rfq_quotations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_quotations_staff_write ON public.rfq_quotations
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_quotations_portal_select ON public.rfq_quotations
  FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()));

-- Quotations are immutable: no UPDATE/DELETE policy on purpose. Supersede or
-- withdraw through the lifecycle RPCs (SECURITY DEFINER).

-- ---------- rfq_quotation_items ----------
CREATE TABLE IF NOT EXISTS public.rfq_quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES public.rfq_quotations(id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES public.rfq_items(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id),
  alternate_product_id uuid REFERENCES public.products(id),
  is_alternate boolean NOT NULL DEFAULT false,
  supplier_product_code text,
  description text,
  quoted_quantity numeric NOT NULL DEFAULT 0,
  quoted_uom_id uuid REFERENCES public.units_of_measure(id),
  base_quantity numeric,
  unit_price numeric NOT NULL DEFAULT 0,
  discount_percent numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  line_total numeric NOT NULL DEFAULT 0,
  lead_time_days integer,
  delivery_date date,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_quotation_items_unique UNIQUE (quotation_id, rfq_item_id)
);

CREATE INDEX IF NOT EXISTS idx_rfq_quotation_items_quotation ON public.rfq_quotation_items(quotation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfq_quotation_items TO authenticated;
GRANT ALL ON public.rfq_quotation_items TO service_role;
ALTER TABLE public.rfq_quotation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY rfq_quotation_items_staff_select ON public.rfq_quotation_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfq_quotations q JOIN public.rfqs r ON r.id = q.rfq_id
                 WHERE q.id = quotation_id
                   AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_quotation_items_staff_write ON public.rfq_quotation_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.rfq_quotations q JOIN public.rfqs r ON r.id = q.rfq_id
                 WHERE q.id = quotation_id
                   AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_quotation_items_portal_select ON public.rfq_quotation_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfq_quotations q
                 WHERE q.id = quotation_id
                   AND q.supplier_id IN (SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid())));

-- ---------- rfq_awards ----------
CREATE TABLE IF NOT EXISTS public.rfq_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.contacts(id),
  quotation_id uuid NOT NULL REFERENCES public.rfq_quotations(id),
  currency text NOT NULL,
  awarded_value numeric NOT NULL DEFAULT 0,
  award_reason text,
  purchase_order_id uuid REFERENCES public.purchase_orders(id),
  converted_at timestamptz,
  awarded_by uuid,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_awards_unique_supplier UNIQUE (rfq_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS public.rfq_award_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES public.rfq_awards(id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES public.rfq_items(id),
  quotation_item_id uuid NOT NULL REFERENCES public.rfq_quotation_items(id),
  awarded_quantity numeric NOT NULL,
  awarded_uom_id uuid REFERENCES public.units_of_measure(id),
  unit_price numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 0,
  line_total numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_award_items_unique UNIQUE (award_id, rfq_item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfq_awards TO authenticated;
GRANT ALL ON public.rfq_awards TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rfq_award_items TO authenticated;
GRANT ALL ON public.rfq_award_items TO service_role;
ALTER TABLE public.rfq_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfq_award_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY rfq_awards_staff_select ON public.rfq_awards
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)));

CREATE POLICY rfq_awards_portal_select ON public.rfq_awards
  FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT c.id FROM public.contacts c WHERE c.portal_user_id = auth.uid()));

CREATE POLICY rfq_award_items_staff_select ON public.rfq_award_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfq_awards a JOIN public.rfqs r ON r.id = a.rfq_id
                 WHERE a.id = award_id
                   AND public.user_can_access_business(auth.uid(), r.business_id)));

-- ---------- rfq_revisions ----------
CREATE TABLE IF NOT EXISTS public.rfq_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES public.rfqs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  reason text,
  snapshot jsonb NOT NULL,
  revised_by uuid,
  revised_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_revisions_unique UNIQUE (rfq_id, version)
);

GRANT SELECT, INSERT ON public.rfq_revisions TO authenticated;
GRANT ALL ON public.rfq_revisions TO service_role;
ALTER TABLE public.rfq_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rfq_revisions_staff_select ON public.rfq_revisions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id
                 AND public.user_can_access_business(auth.uid(), r.business_id)));

-- ---------- downstream traceability ----------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS rfq_id uuid REFERENCES public.rfqs(id),
  ADD COLUMN IF NOT EXISTS rfq_award_id uuid REFERENCES public.rfq_awards(id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_rfq ON public.purchase_orders(rfq_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_rfq_award_unique
  ON public.purchase_orders(rfq_award_id) WHERE rfq_award_id IS NOT NULL;

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS rfq_quotation_item_id uuid REFERENCES public.rfq_quotation_items(id),
  ADD COLUMN IF NOT EXISTS rfq_item_id uuid REFERENCES public.rfq_items(id);

-- ---------- updated_at triggers ----------
CREATE TRIGGER trg_rfq_invitations_updated_at
  BEFORE UPDATE ON public.rfq_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();