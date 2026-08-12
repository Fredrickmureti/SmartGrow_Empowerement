-- ═══ 1. Drop the superseded create_supplier overload (ambiguous RPC) ═══════
DROP FUNCTION IF EXISTS public.create_supplier(
  uuid, uuid, text, text, text, text, text, text, uuid, text, text, integer
);

-- ═══ 2. Party ↔ supplier-role resolution view ══════════════════════════════
CREATE OR REPLACE VIEW public.v_party_supplier AS
SELECT
  c.id                AS contact_id,
  c.business_id,
  c.organization_id,
  c.name              AS party_name,
  c.tax_id,
  c.supplier_rank,
  s.id                AS supplier_id,
  s.supplier_code,
  s.lifecycle_state,
  s.category_id,
  s.default_currency,
  s.default_incoterms,
  s.default_payment_term_id,
  s.default_lead_time_days,
  s.minimum_order_value,
  s.preferred_rank,
  s.hold_reason,
  s.qualification_expires_at,
  (s.id IS NOT NULL AND s.lifecycle_state NOT IN ('suspended','blocked','archived'))
                      AS is_purchasable
FROM public.contacts c
LEFT JOIN public.suppliers s
  ON s.contact_id = c.id
 AND s.business_id = c.business_id
WHERE c.supplier_rank > 0 OR c.type IN ('supplier','both') OR s.id IS NOT NULL;

GRANT SELECT ON public.v_party_supplier TO authenticated;
GRANT SELECT ON public.v_party_supplier TO service_role;

COMMENT ON VIEW public.v_party_supplier IS
  'ADR-0079 party↔role resolution: one row per supplier-role party with its '
  'procurement role record (if any). Reads that need identity + lifecycle in '
  'one shot use this instead of re-joining contacts to suppliers.';

-- ═══ 3. Make the party-keyed RFQ columns self-documenting ══════════════════
COMMENT ON COLUMN public.rfq_invitations.supplier_id IS
  'Business party (contacts.id) invited to quote — ADR-0079: documents key off '
  'the party, never suppliers.id. Join public.suppliers on contact_id for the '
  'procurement role.';
COMMENT ON COLUMN public.rfq_quotations.supplier_id IS
  'Business party (contacts.id) that quoted — ADR-0079 party key, not suppliers.id.';
COMMENT ON COLUMN public.rfq_awards.supplier_id IS
  'Business party (contacts.id) awarded — ADR-0079 party key, not suppliers.id.';
COMMENT ON COLUMN public.rfq_quotation_attachments.supplier_id IS
  'Business party (contacts.id) the attachment belongs to — ADR-0079 party key.';

-- ═══ 4. Extend the purchasability gate to the remaining vendor documents ═══
DROP TRIGGER IF EXISTS trg_purchase_returns_supplier_purchasable ON public.purchase_returns;
CREATE TRIGGER trg_purchase_returns_supplier_purchasable
  BEFORE INSERT OR UPDATE OF vendor_id ON public.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();

DROP TRIGGER IF EXISTS trg_vendor_credit_notes_supplier_purchasable ON public.vendor_credit_notes;
CREATE TRIGGER trg_vendor_credit_notes_supplier_purchasable
  BEFORE INSERT OR UPDATE OF vendor_id ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();

DROP TRIGGER IF EXISTS trg_expenses_supplier_purchasable ON public.expenses;
CREATE TRIGGER trg_expenses_supplier_purchasable
  BEFORE INSERT OR UPDATE OF vendor_id ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._tg_assert_supplier_purchasable();