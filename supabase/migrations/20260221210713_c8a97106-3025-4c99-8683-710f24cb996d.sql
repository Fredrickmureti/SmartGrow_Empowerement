
CREATE OR REPLACE FUNCTION public.check_contact_dependencies(p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deps jsonb := '[]'::jsonb;
  v_count bigint;
BEGIN
  -- proforma_invoices
  SELECT count(*) INTO v_count FROM proforma_invoices WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'proforma_invoices', 'label', 'Proforma Invoices', 'count', v_count);
  END IF;

  -- delivery_notes
  SELECT count(*) INTO v_count FROM delivery_notes WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'delivery_notes', 'label', 'Delivery Notes', 'count', v_count);
  END IF;

  -- sales_orders
  SELECT count(*) INTO v_count FROM sales_orders WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'sales_orders', 'label', 'Sales Orders', 'count', v_count);
  END IF;

  -- sales_returns
  SELECT count(*) INTO v_count FROM sales_returns WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'sales_returns', 'label', 'Sales Returns', 'count', v_count);
  END IF;

  -- journal_entry_lines
  SELECT count(*) INTO v_count FROM journal_entry_lines WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'journal_entry_lines', 'label', 'Journal Entries', 'count', v_count);
  END IF;

  -- invoices
  SELECT count(*) INTO v_count FROM invoices WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'invoices', 'label', 'Invoices', 'count', v_count);
  END IF;

  -- credit_notes
  SELECT count(*) INTO v_count FROM credit_notes WHERE contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'credit_notes', 'label', 'Credit Notes', 'count', v_count);
  END IF;

  -- purchase_orders (vendor)
  SELECT count(*) INTO v_count FROM purchase_orders WHERE vendor_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'purchase_orders', 'label', 'Purchase Orders', 'count', v_count);
  END IF;

  -- bills (vendor)
  SELECT count(*) INTO v_count FROM bills WHERE vendor_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'bills', 'label', 'Bills', 'count', v_count);
  END IF;

  -- purchase_returns (vendor)
  SELECT count(*) INTO v_count FROM purchase_returns WHERE vendor_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'purchase_returns', 'label', 'Purchase Returns', 'count', v_count);
  END IF;

  -- asset_maintenance (vendor)
  SELECT count(*) INTO v_count FROM asset_maintenance WHERE vendor_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'asset_maintenance', 'label', 'Asset Maintenance', 'count', v_count);
  END IF;

  -- fixed_assets (vendor)
  SELECT count(*) INTO v_count FROM fixed_assets WHERE vendor_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'fixed_assets', 'label', 'Fixed Assets', 'count', v_count);
  END IF;

  -- crm_leads (converted)
  SELECT count(*) INTO v_count FROM crm_leads WHERE converted_to_contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'crm_leads', 'label', 'CRM Leads', 'count', v_count);
  END IF;

  -- mpesa_c2b_transactions
  SELECT count(*) INTO v_count FROM mpesa_c2b_transactions WHERE matched_contact_id = p_contact_id;
  IF v_count > 0 THEN
    v_deps := v_deps || jsonb_build_object('table', 'mpesa_c2b_transactions', 'label', 'M-Pesa Transactions', 'count', v_count);
  END IF;

  RETURN jsonb_build_object(
    'can_delete', jsonb_array_length(v_deps) = 0,
    'dependencies', v_deps
  );
END;
$$;
