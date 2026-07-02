-- ============================================================
-- 1) platform_exchange_rates: add display metadata + seed currencies
-- ============================================================

ALTER TABLE public.platform_exchange_rates
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS symbol TEXT;

-- Backfill the seed row that already exists
UPDATE public.platform_exchange_rates
   SET display_name = COALESCE(display_name, 'Kenyan Shilling'),
       symbol       = COALESCE(symbol, 'KSh')
 WHERE from_currency = 'USD' AND to_currency = 'KES';

-- Seed common world currencies (USD-based pairs). Idempotent.
-- Rates are sensible recent mid-market values — admins edit from the UI.
INSERT INTO public.platform_exchange_rates
  (from_currency, to_currency, rate, is_active, display_name, symbol)
VALUES
  ('USD', 'EUR',   0.92,    true, 'Euro',                  '€'),
  ('USD', 'GBP',   0.79,    true, 'British Pound',         '£'),
  ('USD', 'INR',   83.20,   true, 'Indian Rupee',          '₹'),
  ('USD', 'NGN',   1580.00, true, 'Nigerian Naira',        '₦'),
  ('USD', 'ZAR',   18.50,   true, 'South African Rand',    'R'),
  ('USD', 'UGX',   3750.00, true, 'Ugandan Shilling',      'USh'),
  ('USD', 'TZS',   2510.00, true, 'Tanzanian Shilling',    'TSh'),
  ('USD', 'RWF',   1330.00, true, 'Rwandan Franc',         'FRw'),
  ('USD', 'AED',   3.67,    true, 'UAE Dirham',            'د.إ'),
  ('USD', 'CAD',   1.36,    true, 'Canadian Dollar',       'C$'),
  ('USD', 'AUD',   1.52,    true, 'Australian Dollar',     'A$'),
  ('USD', 'JPY',   151.00,  true, 'Japanese Yen',          '¥'),
  ('USD', 'USD',   1.00,    true, 'US Dollar',             '$')
ON CONFLICT (from_currency, to_currency) DO UPDATE
   SET display_name = COALESCE(public.platform_exchange_rates.display_name, EXCLUDED.display_name),
       symbol       = COALESCE(public.platform_exchange_rates.symbol,       EXCLUDED.symbol);

-- ============================================================
-- 2) platform_settings: seed security/access keys (only if missing)
-- ============================================================
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret)
VALUES
  ('allow_new_signups',         'true', 'boolean', 'Whether public sign-up is enabled for new tenant workspaces.', false),
  ('require_email_verification','true', 'boolean', 'Whether tenant signups must verify their email before continuing.', false),
  ('session_timeout_minutes',   '60',   'number',  'Inactivity timeout (minutes) before users are signed out.', false),
  ('password_min_length',       '8',    'number',  'Minimum password length for new accounts.', false),
  ('password_require_uppercase','true', 'boolean', 'Require at least one uppercase letter in passwords.', false),
  ('password_require_number',   'true', 'boolean', 'Require at least one digit in passwords.', false)
ON CONFLICT (setting_key) DO NOTHING;
