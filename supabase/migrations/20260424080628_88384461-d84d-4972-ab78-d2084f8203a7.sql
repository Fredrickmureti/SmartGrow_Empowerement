-- =========================================================================
-- Migration 2: Consolidate `accounts` unique indexes
-- Keep `accounts_business_code_uniq(business_id, code)` as the single source
-- of truth. Drop the COALESCE-based and partial-active variants.
-- business_id is NOT NULL on accounts, so no nullable workaround is needed.
-- =========================================================================
DROP INDEX IF EXISTS public.accounts_org_business_code_key;
DROP INDEX IF EXISTS public.uq_accounts_biz_code_active;

-- =========================================================================
-- Migration 3: Drop legacy reconcile_bank_transaction_atomic overload
-- Frontend uses only the modern (_txn_id, _recon_type, …) signature.
-- The legacy (p_transaction_id, p_entity_type, …) overload is unreferenced
-- and creates RPC selection ambiguity for PostgREST.
-- =========================================================================
DROP FUNCTION IF EXISTS public.reconcile_bank_transaction_atomic(
  p_transaction_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_payment_method text,
  p_notes text
);