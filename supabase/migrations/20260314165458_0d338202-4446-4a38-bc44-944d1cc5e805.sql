
-- Sync account balances to match actual journal entry totals
-- AR (asset): balance = net debit = 500
UPDATE accounts SET current_balance = 500 WHERE id = 'b02cdef1-2968-4624-bcdc-6f80fdc156fc';
-- Customer Deposits (liability): balance = net credit = 1000
UPDATE accounts SET current_balance = 1000 WHERE id = '4c265d7c-2750-4d9f-9748-dbcfeee75db4';
