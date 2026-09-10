DO $$
DECLARE r record; names text[] := ARRAY[
  '_assert_party_address_contact','_assert_ship_to_contact_valid','_consolidation_partner_guard',
  '_stamp_party_snapshot','assert_contact_in_business','consolidation_diagnose_eliminations',
  'consolidation_partner_integrity_report','customer_loyalty_inherit_scope',
  'enforce_bill_vendor_business_match','enforce_po_vendor_business_match','ensure_company_contact',
  'fx_exposure_dimensions','fx_realized_gain_loss','get_vendor_contact_id','is_vendor_portal_user',
  'legal_order_authority_ensure_contact','notify_payment_received','record_advance_payment',
  'record_multi_invoice_payment','resolve_supplier_defaults','rfq_attach_quotation_document',
  'rfq_record_quotation','rfq_remove_quotation_attachment','rfq_withdraw_quotation',
  'update_portal_contact_self'
];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(names)
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig::text;
  END LOOP;
END $$;