-- ═══ A. Party ↔ role convergence ═════════════════════════════════════════

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS lifecycle_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- updated_at maintenance (suppliers had no trigger at all)
DROP TRIGGER IF EXISTS trg_suppliers_updated_at ON public.suppliers;
CREATE TRIGGER trg_suppliers_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Supplier code sequencing (server-authoritative) ─────────────────────
CREATE OR REPLACE FUNCTION public.next_supplier_code(p_business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('supplier_code:' || p_business_id::text));
  SELECT COALESCE(MAX(NULLIF(regexp_replace(supplier_code, '^SUP-', ''), '')::integer), 0)
    INTO v_n
    FROM public.suppliers
   WHERE business_id = p_business_id
     AND supplier_code ~ '^SUP-[0-9]+$';
  RETURN 'SUP-' || lpad((v_n + 1)::text, 5, '0');
END $$;

-- ─── Supplier lifecycle history (audit) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supplier_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason text,
  actor_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, seq)
);

GRANT SELECT ON public.supplier_lifecycle_events TO authenticated;
GRANT ALL ON public.supplier_lifecycle_events TO service_role;
ALTER TABLE public.supplier_lifecycle_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_lifecycle_events_select" ON public.supplier_lifecycle_events;
CREATE POLICY "supplier_lifecycle_events_select"
  ON public.supplier_lifecycle_events FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_supplier_lifecycle_events_supplier
  ON public.supplier_lifecycle_events (supplier_id, seq DESC);

-- ─── Auto-provision the supplier role from the party ─────────────────────
CREATE OR REPLACE FUNCTION public.ensure_supplier_for_contact(p_contact_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_c RECORD; v_id uuid;
BEGIN
  SELECT * INTO v_c FROM public.contacts WHERE id = p_contact_id;
  IF NOT FOUND OR v_c.business_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM public.suppliers
   WHERE business_id = v_c.business_id AND contact_id = v_c.id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO public.suppliers (
    organization_id, business_id, contact_id, supplier_code,
    lifecycle_state, default_currency, default_payment_term_id, created_by
  ) VALUES (
    v_c.organization_id, v_c.business_id, v_c.id,
    public.next_supplier_code(v_c.business_id),
    'draft', v_c.default_currency, v_c.payment_term_id, auth.uid()
  )
  ON CONFLICT (business_id, contact_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.suppliers
     WHERE business_id = v_c.business_id AND contact_id = v_c.id;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public._contacts_provision_supplier_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.supplier_rank, 0) > 0
     OR NEW.type::text IN ('supplier', 'both') THEN
    PERFORM public.ensure_supplier_for_contact(NEW.id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_contacts_provision_supplier_role ON public.contacts;
CREATE TRIGGER trg_contacts_provision_supplier_role
  AFTER INSERT OR UPDATE OF supplier_rank, type ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public._contacts_provision_supplier_role();

-- ─── Backfill every existing supplier-role party ─────────────────────────
INSERT INTO public.suppliers (
  organization_id, business_id, contact_id, supplier_code,
  lifecycle_state, default_currency, default_payment_term_id
)
SELECT c.organization_id, c.business_id, c.id,
       'SUP-' || lpad((row_number() OVER (PARTITION BY c.business_id ORDER BY c.created_at, c.id))::text, 5, '0'),
       'draft', c.default_currency, c.payment_term_id
  FROM public.contacts c
 WHERE c.business_id IS NOT NULL
   AND (COALESCE(c.supplier_rank, 0) > 0 OR c.type::text IN ('supplier', 'both'))
   AND NOT EXISTS (
     SELECT 1 FROM public.suppliers s
      WHERE s.business_id = c.business_id AND s.contact_id = c.id)
ON CONFLICT DO NOTHING;

-- ═══ B. Lifecycle state machine ══════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._supplier_transition(
  p_supplier_id uuid,
  p_to_state text,
  p_allowed_from text[],
  p_event text,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v RECORD; v_seq integer;
BEGIN
  SELECT * INTO v FROM public.suppliers WHERE id = p_supplier_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Supplier not found');
  END IF;
  IF NOT public.user_has_business_access(auth.uid(), v.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v.lifecycle_state = p_to_state THEN
    RETURN jsonb_build_object('success', true, 'noop', true);
  END IF;
  IF NOT (v.lifecycle_state = ANY (p_allowed_from)) THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Cannot move supplier from %s to %s', v.lifecycle_state, p_to_state));
  END IF;

  v_seq := v.lifecycle_seq + 1;

  UPDATE public.suppliers
     SET lifecycle_state = p_to_state,
         lifecycle_seq   = v_seq,
         hold_reason     = CASE WHEN p_to_state IN ('suspended','blocked') THEN p_reason ELSE NULL END,
         archived_at     = CASE WHEN p_to_state = 'archived' THEN now() ELSE NULL END,
         updated_at      = now()
   WHERE id = p_supplier_id;

  INSERT INTO public.supplier_lifecycle_events (
    organization_id, business_id, supplier_id, seq,
    from_state, to_state, reason, actor_user_id, metadata)
  VALUES (v.organization_id, v.business_id, p_supplier_id, v_seq,
          v.lifecycle_state, p_to_state, p_reason, auth.uid(), COALESCE(p_metadata, '{}'::jsonb));

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    old_values, new_values, changes_summary)
  VALUES (v.organization_id, v.business_id, auth.uid(), p_event, 'supplier', p_supplier_id,
          jsonb_build_object('lifecycle_state', v.lifecycle_state),
          jsonb_build_object('lifecycle_state', p_to_state, 'reason', p_reason),
          format('Supplier %s → %s', v.lifecycle_state, p_to_state));

  -- Deterministic idempotency key: one event per (supplier, transition seq).
  INSERT INTO public.business_event_outbox (
    org_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (v.organization_id, p_event, 'supplier', p_supplier_id,
          jsonb_build_object('business_id', v.business_id, 'contact_id', v.contact_id,
                             'from_state', v.lifecycle_state, 'to_state', p_to_state,
                             'reason', p_reason, 'seq', v_seq),
          p_event || ':' || p_supplier_id::text || ':' || v_seq::text,
          auth.uid(), 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'from_state', v.lifecycle_state,
                            'to_state', p_to_state, 'seq', v_seq);
END $$;

CREATE OR REPLACE FUNCTION public.approve_supplier(p_supplier_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'approved',
    ARRAY['draft','qualifying','suspended'], 'supplier.approved', p_notes);
$$;

CREATE OR REPLACE FUNCTION public.block_supplier(p_supplier_id uuid, p_reason text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'blocked',
    ARRAY['draft','qualifying','approved','suspended'], 'supplier.blocked', p_reason);
$$;

CREATE OR REPLACE FUNCTION public.unblock_supplier(p_supplier_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'draft',
    ARRAY['blocked'], 'supplier.unblocked', p_notes);
$$;

CREATE OR REPLACE FUNCTION public.archive_supplier(p_supplier_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'archived',
    ARRAY['draft','qualifying','approved','suspended','blocked'], 'supplier.archived', p_reason);
$$;

CREATE OR REPLACE FUNCTION public.unarchive_supplier(p_supplier_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'draft',
    ARRAY['archived'], 'supplier.unarchived', p_notes);
$$;

-- Rewrite the two pre-existing transitions onto the audited, idempotent helper.
CREATE OR REPLACE FUNCTION public.suspend_supplier(p_supplier_id uuid, p_reason text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'suspended',
    ARRAY['draft','qualifying','approved'], 'supplier.suspended', p_reason);
$$;

CREATE OR REPLACE FUNCTION public.reinstate_supplier(p_supplier_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public._supplier_transition(p_supplier_id, 'approved',
    ARRAY['suspended'], 'supplier.reinstated', p_notes);
$$;

-- ═══ Purchase gate: no procurement against a held party ══════════════════
CREATE OR REPLACE FUNCTION public._assert_supplier_purchasable(
  p_vendor_contact_id uuid, p_business_id uuid, p_doc text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_state text; v_reason text;
BEGIN
  IF p_vendor_contact_id IS NULL OR p_business_id IS NULL THEN RETURN; END IF;
  SELECT lifecycle_state, hold_reason INTO v_state, v_reason
    FROM public.suppliers
   WHERE business_id = p_business_id AND contact_id = p_vendor_contact_id;
  IF v_state IN ('suspended', 'blocked', 'archived') THEN
    RAISE EXCEPTION '% cannot be raised: supplier is %', p_doc, v_state
      USING HINT = COALESCE(v_reason, 'Reinstate the supplier first.'),
            ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._tg_assert_supplier_purchasable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_vendor uuid; v_biz uuid;
BEGIN
  IF TG_TABLE_NAME = 'rfq_invitations' THEN
    v_vendor := NEW.supplier_id;
    SELECT business_id INTO v_biz FROM public.rfqs WHERE id = NEW.rfq_id;
  ELSE
    v_vendor := NEW.vendor_id;
    v_biz := NEW.business_id;
  END IF;
  PERFORM public._assert_supplier_purchasable(v_vendor, v_biz, TG_TABLE_NAME);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_po_supplier_purchasable ON public.purchase_orders;
CREATE TRIGGER trg_po_supplier_purchasable
  BEFORE INSERT OR UPDATE OF vendor_id, status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();

DROP TRIGGER IF EXISTS trg_bills_supplier_purchasable ON public.bills;
CREATE TRIGGER trg_bills_supplier_purchasable
  BEFORE INSERT OR UPDATE OF vendor_id, status ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();

DROP TRIGGER IF EXISTS trg_rfq_inv_supplier_purchasable ON public.rfq_invitations;
CREATE TRIGGER trg_rfq_inv_supplier_purchasable
  BEFORE INSERT ON public.rfq_invitations
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();