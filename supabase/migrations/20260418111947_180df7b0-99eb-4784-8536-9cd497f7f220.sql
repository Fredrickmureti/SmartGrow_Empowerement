-- M-1a: Remove legacy unique index that blocks sub-entries (COGS, WHT, refund, etc.)
-- The correct index `idx_journal_entries_source_unique` (which includes source_subtype) remains.
DROP INDEX IF EXISTS public.uniq_je_per_source;

-- M-1b: Drop unused legacy posting functions (not attached to any trigger).
-- These used fragile name-LIKE account lookups and have been superseded by post_journal_entry_atomic.
DROP FUNCTION IF EXISTS public.create_invoice_journal_entry() CASCADE;
DROP FUNCTION IF EXISTS public.create_bill_journal_entry() CASCADE;
DROP FUNCTION IF EXISTS public.create_payment_journal_entry() CASCADE;
DROP FUNCTION IF EXISTS public.create_bill_payment_journal_entry() CASCADE;