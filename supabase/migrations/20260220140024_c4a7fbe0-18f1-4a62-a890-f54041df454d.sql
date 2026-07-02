
-- ============================================================
-- FIX: Drop stale triggers using non-existent column names
-- (debit_amount / credit_amount) on journal_entry_lines.
-- These triggers cause ALL journal_entry_lines INSERTs to fail
-- with: record "new" has no field "debit_amount"
-- The surviving trigger trg_update_account_balance_on_je_line
-- correctly uses NEW.debit / NEW.credit and remains in place.
-- ============================================================

-- Step 1: Drop the two broken triggers
DROP TRIGGER IF EXISTS trigger_update_account_balance_from_journal ON public.journal_entry_lines;
DROP TRIGGER IF EXISTS trigger_update_account_balance_on_line ON public.journal_entry_lines;

-- Step 2: Drop the now-orphaned broken trigger functions
DROP FUNCTION IF EXISTS public.update_account_balance_from_journal();
DROP FUNCTION IF EXISTS public.update_account_balance_on_journal_line();
