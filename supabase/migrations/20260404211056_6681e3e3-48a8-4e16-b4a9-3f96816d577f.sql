
-- 1. Insert Starter plan
INSERT INTO platform_subscription_plans (
  name, description, price_monthly, price_yearly, currency, features,
  max_users, max_invoices_per_month, max_organizations, is_popular, is_active,
  is_default, trial_period_days, grace_period_days, sort_order, max_storage_mb
) VALUES (
  'Starter',
  'Perfect for small businesses getting started with professional tools',
  29.00, 290.00, 'USD',
  '["Up to 5 users", "100 invoices/month", "Finance & Accounting", "Sales & Purchases", "Inventory Management", "Documents & Spreadsheets", "Email support"]'::jsonb,
  5, 100, 1, false, true, false, 14, 7, 2, 5120
);

-- 2. Fix Enterprise yearly price (was $25,000, should be $1,490)
UPDATE platform_subscription_plans
SET price_yearly = 1490.00,
    description = 'Full platform access with unlimited users, advanced analytics, and priority support',
    features = '["Unlimited users", "Unlimited invoices", "All apps included", "AI Assistant", "Multi-currency", "Business Intelligence", "Audit Logs", "API Access", "Custom Branding", "Priority support", "Up to 10 organizations"]'::jsonb,
    max_organizations = 10,
    max_storage_mb = 102400
WHERE name = 'Enterprise';

-- 3. Update Free plan
UPDATE platform_subscription_plans
SET description = 'Get started with essential accounting and invoicing',
    max_invoices_per_month = 10,
    max_users = 1,
    max_storage_mb = 512,
    features = '["1 user", "10 invoices/month", "Basic Finance", "Basic Sales", "Basic Purchases", "Contacts"]'::jsonb
WHERE name = 'Free';

-- 4. Update Professional plan
UPDATE platform_subscription_plans
SET price_yearly = 790.00,
    description = 'Complete business management suite for growing companies',
    max_users = 15,
    max_organizations = 3,
    max_storage_mb = 25600,
    is_popular = true,
    features = '["Up to 15 users", "Unlimited invoices", "All Growth apps", "POS, HR & Projects", "AI Assistant", "Multi-currency", "Advanced Reports", "Up to 3 organizations"]'::jsonb
WHERE name = 'Professional';

-- 5. Clear existing plan_app_access to rebuild properly
DELETE FROM plan_app_access;

-- 6. Rebuild plan_app_access with proper differentiation
-- Free: finance, sales, purchases, contacts, platform
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('finance'), ('sales'), ('purchases'), ('contacts'), ('platform')) AS app(app_id)
WHERE p.name = 'Free';

-- Free: disabled apps
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, false
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('inventory'), ('crm'), ('documents'), ('sign'), ('spreadsheets'), ('pos'), ('hr'), ('projects'), ('sms'), ('studio'), ('reports')) AS app(app_id)
WHERE p.name = 'Free';

-- Starter: core + growth apps
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('finance'), ('sales'), ('purchases'), ('contacts'), ('platform'), ('inventory'), ('documents'), ('spreadsheets'), ('reports')) AS app(app_id)
WHERE p.name = 'Starter';

INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, false
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('crm'), ('sign'), ('pos'), ('hr'), ('projects'), ('sms'), ('studio')) AS app(app_id)
WHERE p.name = 'Starter';

-- Professional: core + growth + enterprise apps
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('finance'), ('sales'), ('purchases'), ('contacts'), ('platform'), ('inventory'), ('documents'), ('spreadsheets'), ('reports'), ('crm'), ('sign'), ('pos'), ('hr'), ('projects')) AS app(app_id)
WHERE p.name = 'Professional';

INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, false
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('sms'), ('studio')) AS app(app_id)
WHERE p.name = 'Professional';

-- Enterprise: everything enabled
INSERT INTO plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM platform_subscription_plans p
CROSS JOIN (VALUES ('finance'), ('sales'), ('purchases'), ('contacts'), ('platform'), ('inventory'), ('documents'), ('spreadsheets'), ('reports'), ('crm'), ('sign'), ('pos'), ('hr'), ('projects'), ('sms'), ('studio')) AS app(app_id)
WHERE p.name = 'Enterprise';

-- 7. Clear existing plan_feature_access to rebuild properly
DELETE FROM plan_feature_access;

-- 8. Rebuild plan_feature_access with proper differentiation

-- FREE PLAN features (basic only)
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT p.id, f.feature_key, f.is_enabled, f.limit_value
FROM platform_subscription_plans p
CROSS JOIN (VALUES
  ('estimates', true, NULL::integer),
  ('credit_notes', true, NULL),
  ('bills', true, NULL),
  ('journal_entries', true, NULL),
  ('reports_financial', true, NULL),
  ('reports_tax', true, NULL),
  ('max_users', true, 1),
  ('max_invoices', true, 10),
  ('max_organizations', true, 1),
  ('max_businesses', true, 1),
  ('max_branches', true, 1),
  -- Disabled for Free
  ('recurring_invoices', false, NULL),
  ('sales_orders', false, NULL),
  ('delivery_notes', false, NULL),
  ('proforma_invoices', false, NULL),
  ('sales_returns', false, NULL),
  ('purchase_orders', false, NULL),
  ('purchase_returns', false, NULL),
  ('banking', false, NULL),
  ('budgets', false, NULL),
  ('fixed_assets', false, NULL),
  ('multi_currency', false, NULL),
  ('ai_assistant', false, NULL),
  ('audit_logs', false, NULL),
  ('api_access', false, NULL),
  ('custom_branding', false, NULL),
  ('team_management', false, NULL),
  ('business_intelligence', false, NULL),
  ('customer_statements', false, NULL),
  ('inventory', false, NULL),
  ('warehouses', false, NULL),
  ('crm', false, NULL),
  ('hr', false, NULL),
  ('employees', false, NULL),
  ('leave', false, NULL),
  ('timesheets', false, NULL),
  ('payroll', false, NULL),
  ('pos', false, NULL),
  ('projects', false, NULL),
  ('documents', false, NULL),
  ('sign', false, NULL),
  ('spreadsheets', false, NULL),
  ('reports_sales', false, NULL),
  ('reports_stock', false, NULL),
  ('reports_management', false, NULL)
) AS f(feature_key, is_enabled, limit_value)
WHERE p.name = 'Free';

-- STARTER PLAN features
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT p.id, f.feature_key, f.is_enabled, f.limit_value
FROM platform_subscription_plans p
CROSS JOIN (VALUES
  ('estimates', true, NULL::integer),
  ('credit_notes', true, NULL),
  ('bills', true, NULL),
  ('journal_entries', true, NULL),
  ('recurring_invoices', true, NULL),
  ('sales_orders', true, NULL),
  ('delivery_notes', true, NULL),
  ('proforma_invoices', true, NULL),
  ('purchase_orders', true, NULL),
  ('banking', true, NULL),
  ('inventory', true, NULL),
  ('warehouses', true, NULL),
  ('documents', true, NULL),
  ('spreadsheets', true, NULL),
  ('customer_statements', true, NULL),
  ('reports_financial', true, NULL),
  ('reports_tax', true, NULL),
  ('reports_sales', true, NULL),
  ('reports_stock', true, NULL),
  ('team_management', true, NULL),
  ('max_users', true, 5),
  ('max_invoices', true, 100),
  ('max_organizations', true, 1),
  ('max_businesses', true, 2),
  ('max_branches', true, 3),
  -- Disabled for Starter
  ('sales_returns', false, NULL),
  ('purchase_returns', false, NULL),
  ('budgets', false, NULL),
  ('fixed_assets', false, NULL),
  ('multi_currency', false, NULL),
  ('ai_assistant', false, NULL),
  ('audit_logs', false, NULL),
  ('api_access', false, NULL),
  ('custom_branding', false, NULL),
  ('business_intelligence', false, NULL),
  ('reports_management', false, NULL),
  ('crm', false, NULL),
  ('hr', false, NULL),
  ('employees', false, NULL),
  ('leave', false, NULL),
  ('timesheets', false, NULL),
  ('payroll', false, NULL),
  ('pos', false, NULL),
  ('projects', false, NULL),
  ('sign', false, NULL)
) AS f(feature_key, is_enabled, limit_value)
WHERE p.name = 'Starter';

-- PROFESSIONAL PLAN features
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT p.id, f.feature_key, f.is_enabled, f.limit_value
FROM platform_subscription_plans p
CROSS JOIN (VALUES
  ('estimates', true, NULL::integer),
  ('credit_notes', true, NULL),
  ('bills', true, NULL),
  ('journal_entries', true, NULL),
  ('recurring_invoices', true, NULL),
  ('sales_orders', true, NULL),
  ('delivery_notes', true, NULL),
  ('proforma_invoices', true, NULL),
  ('sales_returns', true, NULL),
  ('purchase_orders', true, NULL),
  ('purchase_returns', true, NULL),
  ('banking', true, NULL),
  ('budgets', true, NULL),
  ('fixed_assets', true, NULL),
  ('multi_currency', true, NULL),
  ('ai_assistant', true, NULL),
  ('inventory', true, NULL),
  ('warehouses', true, NULL),
  ('documents', true, NULL),
  ('sign', true, NULL),
  ('spreadsheets', true, NULL),
  ('crm', true, NULL),
  ('hr', true, NULL),
  ('employees', true, NULL),
  ('leave', true, NULL),
  ('timesheets', true, NULL),
  ('pos', true, NULL),
  ('projects', true, NULL),
  ('customer_statements', true, NULL),
  ('team_management', true, NULL),
  ('reports_financial', true, NULL),
  ('reports_tax', true, NULL),
  ('reports_sales', true, NULL),
  ('reports_stock', true, NULL),
  ('reports_management', true, NULL),
  ('max_users', true, 15),
  ('max_invoices', true, NULL),
  ('max_organizations', true, 3),
  ('max_businesses', true, 5),
  ('max_branches', true, 10),
  -- Disabled for Professional
  ('audit_logs', false, NULL),
  ('api_access', false, NULL),
  ('custom_branding', false, NULL),
  ('business_intelligence', false, NULL),
  ('payroll', false, NULL)
) AS f(feature_key, is_enabled, limit_value)
WHERE p.name = 'Professional';

-- ENTERPRISE PLAN features (everything enabled)
INSERT INTO plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT p.id, f.feature_key, f.is_enabled, f.limit_value
FROM platform_subscription_plans p
CROSS JOIN (VALUES
  ('estimates', true, NULL::integer),
  ('credit_notes', true, NULL),
  ('bills', true, NULL),
  ('journal_entries', true, NULL),
  ('recurring_invoices', true, NULL),
  ('sales_orders', true, NULL),
  ('delivery_notes', true, NULL),
  ('proforma_invoices', true, NULL),
  ('sales_returns', true, NULL),
  ('purchase_orders', true, NULL),
  ('purchase_returns', true, NULL),
  ('banking', true, NULL),
  ('budgets', true, NULL),
  ('fixed_assets', true, NULL),
  ('multi_currency', true, NULL),
  ('ai_assistant', true, NULL),
  ('audit_logs', true, NULL),
  ('api_access', true, NULL),
  ('custom_branding', true, NULL),
  ('business_intelligence', true, NULL),
  ('inventory', true, NULL),
  ('warehouses', true, NULL),
  ('documents', true, NULL),
  ('sign', true, NULL),
  ('spreadsheets', true, NULL),
  ('crm', true, NULL),
  ('hr', true, NULL),
  ('employees', true, NULL),
  ('leave', true, NULL),
  ('timesheets', true, NULL),
  ('payroll', true, NULL),
  ('pos', true, NULL),
  ('projects', true, NULL),
  ('customer_statements', true, NULL),
  ('team_management', true, NULL),
  ('reports_financial', true, NULL),
  ('reports_tax', true, NULL),
  ('reports_sales', true, NULL),
  ('reports_stock', true, NULL),
  ('reports_management', true, NULL),
  ('max_users', true, NULL),
  ('max_invoices', true, NULL),
  ('max_organizations', true, 10),
  ('max_businesses', true, NULL),
  ('max_branches', true, NULL)
) AS f(feature_key, is_enabled, limit_value)
WHERE p.name = 'Enterprise';
