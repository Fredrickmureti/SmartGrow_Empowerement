
-- Auto-create "Customer Deposits" liability account for each org+business
-- that has an accounts chart but no customer deposits/advances account.
-- This ensures overpayments and advances are posted to the correct liability account.

DO $$
DECLARE
  r RECORD;
  v_new_id uuid;
  v_code text;
BEGIN
  -- For each org+business combination that has accounts but no customer deposit account
  FOR r IN
    SELECT DISTINCT a.organization_id, a.business_id
    FROM accounts a
    WHERE a.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM accounts a2
        WHERE a2.organization_id = a.organization_id
          AND (a2.business_id = a.business_id OR (a2.business_id IS NULL AND a.business_id IS NULL))
          AND a2.account_type = 'liability'
          AND a2.is_active = true
          AND (
            lower(a2.name) LIKE '%customer deposit%'
            OR lower(a2.name) LIKE '%customer advance%'
            OR lower(a2.name) LIKE '%customer credit%'
            OR lower(a2.name) LIKE '%unearned revenue%'
          )
      )
  LOOP
    v_new_id := gen_random_uuid();
    -- Find next available code in 2xxx range for liability
    SELECT COALESCE(MAX(a.code::int) + 1, 2100)::text INTO v_code
    FROM accounts a
    WHERE a.organization_id = r.organization_id
      AND (a.business_id = r.business_id OR (a.business_id IS NULL AND r.business_id IS NULL))
      AND a.code ~ '^\d+$'
      AND a.code::int BETWEEN 2000 AND 2999;

    INSERT INTO accounts (id, organization_id, business_id, account_type, code, name, description, is_system, is_active, detail_type)
    VALUES (
      v_new_id,
      r.organization_id,
      r.business_id,
      'liability',
      v_code,
      'Customer Deposits & Advances',
      'Liability account for customer overpayments, advance payments, and unapplied credits. Do not use Accounts Payable for customer liabilities.',
      true,
      true,
      'current_liability'
    );

    -- Auto-map it in default_account_settings
    INSERT INTO default_account_settings (organization_id, business_id, setting_key, account_id)
    VALUES (r.organization_id, r.business_id, 'customer_deposits', v_new_id)
    ON CONFLICT (organization_id, business_id, setting_key) DO NOTHING;
  END LOOP;
END $$;
