
-- Delete default_account_settings rows for this org first (has NOT NULL on account_id)
DELETE FROM default_account_settings 
WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';

-- Now nullify other FK references
UPDATE accounts SET parent_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE asset_categories SET asset_account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE asset_categories SET accumulated_depreciation_account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE asset_categories SET depreciation_account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE asset_categories SET gain_loss_account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE bill_items SET account_id = NULL WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324');
UPDATE bills SET account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';
UPDATE budget_items SET account_id = NULL WHERE budget_id IN (SELECT id FROM budgets WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324');
UPDATE budget_actuals SET account_id = NULL WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';

-- Delete the accounts
DELETE FROM accounts WHERE organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324';

-- Create the reusable cascading delete function
CREATE OR REPLACE FUNCTION public.delete_all_chart_of_accounts(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE user_id = auth.uid() 
    AND organization_id = p_organization_id 
    AND role IN ('owner', 'admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COUNT(*) INTO v_count FROM accounts WHERE organization_id = p_organization_id;

  -- Delete rows with NOT NULL constraint first
  DELETE FROM default_account_settings WHERE organization_id = p_organization_id;

  -- Nullify remaining FK references
  UPDATE accounts SET parent_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET asset_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET accumulated_depreciation_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET depreciation_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET gain_loss_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE bill_items SET account_id = NULL WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = p_organization_id);
  UPDATE bills SET account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE budget_items SET account_id = NULL WHERE budget_id IN (SELECT id FROM budgets WHERE organization_id = p_organization_id);
  UPDATE budget_actuals SET account_id = NULL WHERE organization_id = p_organization_id;

  DELETE FROM accounts WHERE organization_id = p_organization_id;

  RETURN jsonb_build_object('deleted_count', v_count, 'success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_all_chart_of_accounts(uuid) TO authenticated;
