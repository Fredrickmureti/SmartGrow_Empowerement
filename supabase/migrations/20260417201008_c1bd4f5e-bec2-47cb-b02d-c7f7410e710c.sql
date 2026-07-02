DO $$
DECLARE
  org_id uuid := '0a1691f2-1d76-430d-809c-68955e560ec7';
BEGIN
  DELETE FROM bank_reconciliation_items WHERE session_id IN (SELECT id FROM bank_reconciliation_sessions WHERE organization_id=org_id);
  DELETE FROM bank_reconciliation_sessions WHERE organization_id=org_id;
  DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE organization_id=org_id) OR payment_id IN (SELECT id FROM bill_payments WHERE organization_id=org_id);
  DELETE FROM bill_payments WHERE organization_id=org_id;
  DELETE FROM payments WHERE organization_id=org_id;
  DELETE FROM credit_note_applications WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id);
  DELETE FROM credit_note_items WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id);
  DELETE FROM credit_notes WHERE organization_id=org_id;
  DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id);
  DELETE FROM sales_returns WHERE organization_id=org_id;
  DELETE FROM delivery_note_items WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id);
  DELETE FROM delivery_notes WHERE organization_id=org_id;
  DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id);
  DELETE FROM invoices WHERE organization_id=org_id;
  DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id);
  DELETE FROM bills WHERE organization_id=org_id;
  DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=org_id);
  DELETE FROM purchase_orders WHERE organization_id=org_id;
  DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id);
  DELETE FROM sales_orders WHERE organization_id=org_id;
  DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id);
  DELETE FROM proforma_invoices WHERE organization_id=org_id;
  DELETE FROM estimate_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id=org_id);
  DELETE FROM estimates WHERE organization_id=org_id;
  DELETE FROM recurring_invoices WHERE organization_id=org_id;
  DELETE FROM expenses WHERE organization_id=org_id;
  DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id);
  DELETE FROM journal_entries WHERE organization_id=org_id;
  DELETE FROM bank_transactions WHERE organization_id=org_id;

  INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, entity_name, changes_summary)
  VALUES (org_id, 'deleted', 'organization', org_id, 'Boma Net Solutions', 'Manual go-live wipe via migration (Lovable plan-approved)');
END $$;