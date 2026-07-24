-- ADR-0093 Phase R1 — enforce master-data IDs on legal_orders_records.
-- authority_id (→ legal_order_authorities) and recipient_id (→ legal_recipients)
-- are the canonical linkages; the retired *_contact_id overlay columns must
-- never be the sole linkage again.

ALTER TABLE public.legal_orders_records
  ADD CONSTRAINT legal_orders_records_master_ids_required
  CHECK (authority_id IS NOT NULL AND recipient_id IS NOT NULL) NOT VALID;

ALTER TABLE public.legal_orders_records
  VALIDATE CONSTRAINT legal_orders_records_master_ids_required;

COMMENT ON CONSTRAINT legal_orders_records_master_ids_required
  ON public.legal_orders_records IS
  'ADR-0093: every legal order must link to a legal_order_authorities row (authority_id) and a legal_recipients row (recipient_id). The retired authority_contact_id/recipient_contact_id overlay columns are not sufficient.';
