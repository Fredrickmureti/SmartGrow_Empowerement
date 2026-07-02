-- Wave 2: Broaden role_key coverage on default_chart_of_accounts.
--
-- After auditing the 678 untagged template rows we found that the vast
-- majority are intentionally role-less:
--   * Section headers (Cash and Cash Equivalents, Revenue, Non-Current
--     Assets) — these are parents, not posting targets.
--   * Statutory payroll payables (CPP/EI, Lohnsteuer, PAYG, TDS, Zakat,
--     etc.) — covered by per-country statutory rules, not generic roles.
--   * Optional subaccounts (Computer Equipment, Motor Vehicles, Land &
--     Buildings under Fixed Assets) — leaf categorisation only.
--
-- This wave only stamps role_key on rows that DO map cleanly to a
-- canonical system_account_roles entry:
--   * Bank Charges (per country) → bank_fees
--   * Depreciation (per country) → depreciation_expense
--   * Foreign Exchange Gains (KE)  → fx_realized_gain
--   * Foreign Exchange Losses (KE) → fx_realized_loss
--
-- After this migration the remaining 634 untagged rows are correctly
-- role-less by design and should not be force-tagged by future waves.

UPDATE public.default_chart_of_accounts
SET role_key = 'bank_fees'
WHERE role_key IS NULL
  AND account_type = 'expense'
  AND detail_type = 'bank_charges'
  AND lower(account_name) = 'bank charges';

UPDATE public.default_chart_of_accounts
SET role_key = 'depreciation_expense'
WHERE role_key IS NULL
  AND account_type = 'expense'
  AND detail_type = 'depreciation'
  AND lower(account_name) = 'depreciation';

UPDATE public.default_chart_of_accounts
SET role_key = 'fx_realized_gain'
WHERE role_key IS NULL
  AND account_type = 'income'
  AND lower(account_name) IN ('foreign exchange gains','foreign exchange gain','fx gain','fx gains');

UPDATE public.default_chart_of_accounts
SET role_key = 'fx_realized_loss'
WHERE role_key IS NULL
  AND account_type = 'expense'
  AND lower(account_name) IN ('foreign exchange losses','foreign exchange loss','fx loss','fx losses');