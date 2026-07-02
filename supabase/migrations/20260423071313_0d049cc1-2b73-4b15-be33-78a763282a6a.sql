-- =============================================================================
-- Fix function overload ambiguity (PG 42725)
-- For each pair, drop the OLDER short-arg version. The newer version has
-- DEFAULT NULL on the extra parameters, so existing short-form callers
-- continue to resolve unambiguously to the single remaining overload.
-- =============================================================================

-- 1. get_next_employee_number — currently breaking onboarding
DROP FUNCTION IF EXISTS public.get_next_employee_number(uuid);

-- 2. get_next_invoice_number — would break invoice creation, POS, estimates,
--    sales orders, recurring invoices, proforma invoices
DROP FUNCTION IF EXISTS public.get_next_invoice_number(uuid);

-- 3. generate_next_je_number — would break every JE-creating RPC
DROP FUNCTION IF EXISTS public.generate_next_je_number(uuid);

-- 4. get_account_movements — would break Cash Flow report, Financial reports,
--    Fiscal Period detail, Year-End closing, GL totals service.
--    Surviving overload: (uuid, date, date, uuid DEFAULT NULL, uuid DEFAULT NULL)
DROP FUNCTION IF EXISTS public.get_account_movements(uuid, date, date, uuid);

-- 5. create_journal_entry_atomic — 10-arg version is now dead code; the
--    canonical version is the 11-arg branch-aware one. Dropping the dead
--    overload prevents ambiguity if a caller ever forgets _branch_id.
DROP FUNCTION IF EXISTS public.create_journal_entry_atomic(
  uuid, uuid, text, date, text, text, boolean, boolean, uuid, jsonb
);