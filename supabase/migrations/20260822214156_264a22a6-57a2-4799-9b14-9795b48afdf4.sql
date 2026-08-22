-- Phase 4 cleanup: the Budget vs Actual report is now computed live from the
-- ledger, so the stored actuals materialization is retired. Keeping it would
-- leave a second, stale definition of "actual".

DROP FUNCTION IF EXISTS public.recalculate_budget_actuals(uuid);
DROP TABLE IF EXISTS public.budget_actuals;

-- Chart-of-accounts wipe: budget lines are NOT NULL on account_id, so the old
-- "nullify the reference" step could never succeed. Budget plan lines cannot
-- exist without an account, so they are removed with the accounts.
CREATE OR REPLACE FUNCTION public.delete_all_chart_of_accounts(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  DELETE FROM budget_revision_lines
    WHERE revision_id IN (
      SELECT br.id FROM budget_revisions br
      JOIN budgets b ON b.id = br.budget_id
      WHERE b.organization_id = p_organization_id
    );
  DELETE FROM budget_items
    WHERE budget_id IN (SELECT id FROM budgets WHERE organization_id = p_organization_id);

  -- Nullify remaining FK references
  UPDATE accounts SET parent_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET asset_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET accumulated_depreciation_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET depreciation_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE asset_categories SET gain_loss_account_id = NULL WHERE organization_id = p_organization_id;
  UPDATE bill_items SET account_id = NULL WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = p_organization_id);
  UPDATE bills SET account_id = NULL WHERE organization_id = p_organization_id;

  DELETE FROM accounts WHERE organization_id = p_organization_id;

  RETURN jsonb_build_object('deleted_count', v_count, 'success', true);
END;
$function$;