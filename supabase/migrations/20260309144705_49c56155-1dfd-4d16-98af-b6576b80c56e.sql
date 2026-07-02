
-- =============================================================
-- FORENSIC FIX: Void orphaned duplicate bill payment journal entry
-- 
-- ROOT CAUSE: During the bill payment workflow, the old non-atomic
-- code path partially succeeded creating JE-00006 (Dr AP / Cr AR — wrong accounts!)
-- before encountering a duplicate key error. The retry via the new atomic RPC
-- then correctly created JE-00007 (Dr AP / Cr Cash).
--
-- JE-00006 is:
-- 1. An orphan — no bill_payment record references it
-- 2. Uses WRONG accounts (Cr Accounts Receivable instead of Cr Cash)
-- 3. A duplicate of the correct JE-00007
--
-- Impact: Double-counted AP reduction + incorrect AR credit = Balance Sheet off by 5,000
-- =============================================================

-- Void the orphaned JE-00006
UPDATE journal_entries 
SET status = 'voided',
    voided_at = now(),
    void_reason = 'Orphaned duplicate bill payment entry created by old non-atomic code path. Correct entry is JE-00007.'
WHERE id = 'dcc8373d-6567-48e7-8be3-e418bb3c8e78'
  AND entry_number = 'JE-00006'
  AND status = 'posted';

-- =============================================================
-- SAFEGUARD: Add a unique constraint to prevent duplicate bill payment JEs.
-- Each bill_payment can only have ONE journal entry.
-- The bill_payments table already has journal_entry_id, so this prevents
-- any future scenario where two JEs are created for the same payment.
-- =============================================================

-- Add unique constraint on bill_payments.journal_entry_id (prevents two payments pointing to same JE)
-- Note: journal_entry_id can be NULL for legacy records, so this only constrains non-null values
CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_payments_journal_entry_unique 
ON bill_payments (journal_entry_id) 
WHERE journal_entry_id IS NOT NULL;
