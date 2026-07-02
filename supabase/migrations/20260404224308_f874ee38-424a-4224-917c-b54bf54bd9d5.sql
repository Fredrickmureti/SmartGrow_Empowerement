UPDATE platform_subscription_plans 
SET 
  price_monthly = 14.00,
  price_yearly = 140.00,
  price_monthly_kes = 1800,
  price_yearly_kes = 18000,
  features = '["Up to 10 users", "Unlimited invoices", "Purchases & inventory", "Financial reports", "Documents & Sign", "Spreadsheets", "Priority email support"]'::jsonb,
  max_users = 10,
  max_organizations = 1,
  max_storage_mb = 5120,
  max_invoices_per_month = NULL,
  price_per_user_monthly = 4,
  price_per_user_yearly = 40
WHERE name = 'Growth';

UPDATE platform_subscription_plans 
SET 
  price_monthly = 29.00,
  price_yearly = 290.00,
  price_monthly_kes = 3700,
  price_yearly_kes = 37000,
  features = '["Up to 25 users", "Unlimited invoices", "All apps included", "Point of Sale", "HR & Payroll", "CRM & Projects", "Multi-currency", "AI assistant", "Priority support"]'::jsonb,
  max_users = 25,
  max_organizations = 3,
  max_storage_mb = 25600,
  max_invoices_per_month = NULL,
  price_per_user_monthly = 7,
  price_per_user_yearly = 70
WHERE name = 'Business';

UPDATE platform_subscription_plans 
SET 
  price_monthly = 59.00,
  price_yearly = 590.00,
  price_monthly_kes = 7500,
  price_yearly_kes = 75000,
  features = '["Unlimited users", "Unlimited invoices", "All apps included", "All premium features", "Multi-currency", "AI assistant", "Audit logs", "Team management", "Dedicated support", "Custom integrations"]'::jsonb,
  max_users = NULL,
  max_organizations = 10,
  max_storage_mb = 102400,
  max_invoices_per_month = NULL,
  price_per_user_monthly = 5,
  price_per_user_yearly = 50
WHERE name = 'Enterprise';