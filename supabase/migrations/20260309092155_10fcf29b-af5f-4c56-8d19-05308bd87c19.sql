-- Migration: Drop legacy GL triggers that duplicate journal entry creation
-- These triggers conflict with the application-level GL posting system

-- Remove legacy payment trigger that duplicates GL entries
DROP TRIGGER IF EXISTS trigger_payment_journal_entry ON payments;
DROP FUNCTION IF EXISTS create_payment_journal_entry();

-- Remove legacy invoice trigger that duplicates GL entries  
DROP TRIGGER IF EXISTS trigger_invoice_journal_entry ON invoices;
DROP FUNCTION IF EXISTS create_invoice_journal_entry();