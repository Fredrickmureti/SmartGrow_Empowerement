
-- =====================================================================
-- Enforce account.detail_type integrity at insert/update time
-- =====================================================================
-- Treats any account that has children as a non-postable group account,
-- even if is_header was not flagged correctly during provisioning. This
-- matches the actual data model: parent accounts are sums of their
-- children and are not used for postings.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.enforce_account_detail_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolved text;
  v_catalog_type text;
  v_has_children boolean;
BEGIN
  -- Explicit header flag: exempt.
  IF COALESCE(NEW.is_header, false) THEN
    RETURN NEW;
  END IF;

  -- Structural header (has children): exempt. Many tenants have parent
  -- accounts whose is_header flag was never set during provisioning;
  -- those rows must not be blocked by this trigger.
  SELECT EXISTS (
    SELECT 1 FROM public.accounts c WHERE c.parent_id = NEW.id
  ) INTO v_has_children;

  IF v_has_children THEN
    RETURN NEW;
  END IF;

  -- Auto-classify when missing. Mirrors backfill_account_detail_types
  -- so there is a single source of truth for name-based classification.
  IF NEW.detail_type IS NULL THEN
    v_resolved := CASE
      -- ASSETS
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'mobile money|m-?pesa|airtel money|wallet|mobile wallet' THEN 'mobile_money'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'money market' THEN 'money_market'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'savings' THEN 'savings'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'petty cash|cash on hand|cash in hand|^cash$|cash drawer|till' THEN 'cash_on_hand'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'bank|checking|current account' THEN 'checking'
      WHEN NEW.account_type = 'asset' AND (lower(NEW.name) ~ 'receivable|debtor' OR NEW.code LIKE '12%') THEN 'accounts_receivable'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'inventory|stock' THEN 'inventory'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'input tax|tax input|gst receivable|prepaid tax' THEN 'tax_input'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'fixed asset|equipment|machinery|vehicle|building|land' THEN 'fixed_asset_other'
      WHEN NEW.account_type = 'asset' AND lower(NEW.name) ~ 'accumulated depreciation' THEN 'accumulated_depreciation'
      -- LIABILITIES
      WHEN NEW.account_type = 'liability' AND lower(NEW.name) ~ 'credit card|visa|mastercard|amex' THEN 'credit_card'
      WHEN NEW.account_type = 'liability' AND lower(NEW.name) ~ 'loan|mortgage|note payable' THEN 'notes_payable'
      WHEN NEW.account_type = 'liability' AND lower(NEW.name) ~ 'line of credit|overdraft' THEN 'line_of_credit'
      WHEN NEW.account_type = 'liability'
           AND lower(NEW.name) ~ 'payable|creditor'
           AND lower(NEW.name) !~ 'tax|vat|salary|salaries|payroll|pension|nssf|shif|nhif|ahl|nita|paye|statutory|withheld|withholding|net salary'
           AND COALESCE(NEW.code, '') NOT IN ('2140','2150','2160','2170')
        THEN 'accounts_payable'
      WHEN NEW.account_type = 'liability' AND lower(NEW.name) ~ 'sales tax|vat payable|output tax' THEN 'sales_tax_payable'
      WHEN NEW.account_type = 'liability' AND lower(NEW.name) ~ 'customer deposit|unearned' THEN 'customer_deposits'
      -- INCOME
      WHEN NEW.account_type = 'income' AND lower(NEW.name) ~ 'service' THEN 'service_income'
      WHEN NEW.account_type = 'income' AND lower(NEW.name) ~ 'interest' THEN 'interest_income'
      WHEN NEW.account_type = 'income' AND lower(NEW.name) ~ 'rental|rent income' THEN 'rental_income'
      WHEN NEW.account_type = 'income' AND lower(NEW.name) ~ 'other income' THEN 'other_income'
      WHEN NEW.account_type = 'income' THEN 'sales_income'
      -- EXPENSE
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'cost of goods|cogs' THEN 'cost_of_goods_sold'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'depreciation' THEN 'depreciation'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'rent' THEN 'rent_expense'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'salaries|wages|payroll' THEN 'payroll_expense'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'utilit' THEN 'utilities'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'bank charge|bank fee' THEN 'bank_charges'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'insurance' THEN 'insurance_expense'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'office' THEN 'office_expenses'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'travel' THEN 'travel'
      WHEN NEW.account_type = 'expense' AND lower(NEW.name) ~ 'legal|professional' THEN 'legal_professional_fees'
      WHEN NEW.account_type = 'expense' THEN 'other_business_expenses'
      -- EQUITY
      WHEN NEW.account_type = 'equity' AND lower(NEW.name) ~ 'retained' THEN 'retained_earnings'
      WHEN NEW.account_type = 'equity' AND lower(NEW.name) ~ 'opening balance' THEN 'opening_balance_equity'
      ELSE NULL
    END;

    IF v_resolved IS NULL THEN
      RAISE EXCEPTION
        'Account %/% (account_type=%): detail_type is required for postable (leaf) accounts. Auto-classification could not infer it from the name. Pick a detail_type from account_detail_type_catalog whose account_type matches.',
        NEW.code, NEW.name, NEW.account_type
        USING ERRCODE = '22023';
    END IF;

    NEW.detail_type := v_resolved;
  END IF;

  -- Catalog consistency check.
  SELECT account_type::text INTO v_catalog_type
    FROM public.account_detail_type_catalog
   WHERE detail_type = NEW.detail_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Account %/%: detail_type "%" is not registered in account_detail_type_catalog.',
      NEW.code, NEW.name, NEW.detail_type
      USING ERRCODE = '22023';
  END IF;

  IF v_catalog_type IS DISTINCT FROM NEW.account_type::text THEN
    RAISE EXCEPTION
      'Account %/%: detail_type "%" belongs to account_type "%" but this account is "%". Pick a matching detail_type.',
      NEW.code, NEW.name, NEW.detail_type, v_catalog_type, NEW.account_type
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_account_detail_type() IS
  'BEFORE INSERT/UPDATE trigger on public.accounts. Guarantees postable (leaf, non-header) accounts carry a valid detail_type matching account_type and registered in account_detail_type_catalog. Auto-classifies from name (same rules as backfill_account_detail_types); rejects when no rule matches. Header accounts and parent accounts (those with children) are exempt.';

DROP TRIGGER IF EXISTS trg_enforce_account_detail_type ON public.accounts;
CREATE TRIGGER trg_enforce_account_detail_type
  BEFORE INSERT OR UPDATE OF detail_type, name, account_type, code, is_header, parent_id
  ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_account_detail_type();

-- =====================================================================
-- Best-effort heal of existing tenants. Per-business EXCEPTION wrapper
-- means a business with un-classifiable leaf accounts is logged and
-- skipped (the new "Repair account metadata" button in Settings handles
-- those cases interactively). No fake fallback values are written.
-- =====================================================================
DO $heal$
DECLARE
  v_business uuid;
  v_repaired integer;
  v_total integer := 0;
  v_ok integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_business IN
    SELECT DISTINCT a.business_id
      FROM public.accounts a
     WHERE a.detail_type IS NULL
       AND COALESCE(a.is_header, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)
  LOOP
    BEGIN
      v_repaired := public.backfill_account_detail_types(_business_id := v_business);
      v_total := v_total + COALESCE(v_repaired, 0);
      v_ok := v_ok + 1;
      RAISE NOTICE 'heal: backfilled % accounts for business %', v_repaired, v_business;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'heal: skipped business % (use the Repair button in Settings): %', v_business, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'heal complete: % accounts updated across % businesses (% skipped)', v_total, v_ok, v_skipped;
END;
$heal$;
