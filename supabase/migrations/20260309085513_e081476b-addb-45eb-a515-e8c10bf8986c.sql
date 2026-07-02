
-- Disable protective triggers temporarily
ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_enforce_journal_entry_lines_immutability;
ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_enforce_fiscal_period_lock;
ALTER TABLE journal_entry_lines DISABLE TRIGGER trg_update_account_balance_on_je_line;
ALTER TABLE journal_entries DISABLE TRIGGER trg_enforce_journal_entry_immutability;
ALTER TABLE journal_entries DISABLE TRIGGER trigger_validate_fiscal_period;

-- Delete all JE data
DELETE FROM journal_entry_lines;
DELETE FROM journal_entries;

-- Delete account references
DELETE FROM default_account_settings;
DELETE FROM default_account_mappings;
DELETE FROM gl_transaction_mappings;
DELETE FROM bank_accounts;
DELETE FROM budget_actuals;
DELETE FROM asset_categories;

-- Delete all accounts
DELETE FROM accounts;

-- Re-enable triggers
ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_enforce_journal_entry_lines_immutability;
ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_enforce_fiscal_period_lock;
ALTER TABLE journal_entry_lines ENABLE TRIGGER trg_update_account_balance_on_je_line;
ALTER TABLE journal_entries ENABLE TRIGGER trg_enforce_journal_entry_immutability;
ALTER TABLE journal_entries ENABLE TRIGGER trigger_validate_fiscal_period;
