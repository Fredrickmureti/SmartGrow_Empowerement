
-- Update Free plan pricing and features
UPDATE platform_subscription_plans SET 
  price_monthly_kes = 0,
  price_yearly_kes = 0,
  features = '["1 user", "50 invoices/month", "Basic accounting", "Contacts management", "Sales & purchases", "Email support"]'::jsonb
WHERE id = '72cbf130-6de2-4f6d-9cbb-b736ff8452d8';

-- Update Starter plan with competitive pricing  
UPDATE platform_subscription_plans SET 
  price_monthly = 15,
  price_yearly = 144,
  price_monthly_kes = 1950,
  price_yearly_kes = 18720,
  features = '["3 users", "Unlimited invoices", "All core apps", "Documents & Sign", "Spreadsheets", "Inventory management", "Reports & analytics", "Audit logs", "Priority email support"]'::jsonb
WHERE id = '573f3b28-a287-4d1f-bf02-eb5455824e67';

-- Update Professional plan with competitive pricing
UPDATE platform_subscription_plans SET 
  price_monthly = 35,
  price_yearly = 336,
  price_monthly_kes = 4550,
  price_yearly_kes = 43680,
  features = '["10 users", "Unlimited invoices", "All apps included", "POS & restaurant mode", "HR & payroll", "CRM & pipeline", "Project management", "Multi-currency", "AI assistant", "Team management", "Attendance tracking", "Priority support"]'::jsonb
WHERE id = '3e4fbab0-3652-43c7-85db-f2dbe0d66884';

-- Update Enterprise plan with competitive pricing
UPDATE platform_subscription_plans SET 
  price_monthly = 65,
  price_yearly = 624,
  price_monthly_kes = 8450,
  price_yearly_kes = 81120,
  features = '["25 users", "Unlimited invoices", "All apps included", "All premium features", "Custom branding", "API access", "Business intelligence", "Advanced security", "Dedicated support"]'::jsonb,
  max_users = 25
WHERE id = '2e45711a-cdae-43ee-97a1-138c83010206';
