-- Insert dummy contacts (customers and vendors)
INSERT INTO public.contacts (organization_id, name, email, phone, type, company, address_line1, city, country)
SELECT 
  org.id,
  contact_data.name,
  contact_data.email,
  contact_data.phone,
  contact_data.type::contact_type,
  contact_data.company,
  contact_data.address,
  contact_data.city,
  contact_data.country
FROM public.organizations org
CROSS JOIN (VALUES
  ('John Smith', 'john@techcorp.com', '+1-555-0101', 'customer', 'TechCorp Inc', '123 Tech Blvd', 'San Francisco', 'USA'),
  ('Sarah Johnson', 'sarah@designstudio.com', '+1-555-0102', 'customer', 'Design Studio LLC', '456 Creative Ave', 'New York', 'USA'),
  ('Mike Chen', 'mike@globalimports.com', '+1-555-0103', 'vendor', 'Global Imports Co', '789 Trade St', 'Los Angeles', 'USA'),
  ('Emily Davis', 'emily@supplyhub.com', '+1-555-0104', 'vendor', 'Supply Hub', '321 Warehouse Rd', 'Chicago', 'USA'),
  ('Robert Wilson', 'robert@acmecorp.com', '+1-555-0105', 'both', 'Acme Corporation', '555 Business Park', 'Seattle', 'USA'),
  ('Lisa Anderson', 'lisa@startupxyz.com', '+1-555-0106', 'customer', 'Startup XYZ', '100 Innovation Dr', 'Austin', 'USA'),
  ('David Brown', 'david@manufacturing.com', '+1-555-0107', 'vendor', 'Manufacturing Plus', '200 Factory Ln', 'Detroit', 'USA'),
  ('Jennifer Lee', 'jennifer@retailco.com', '+1-555-0108', 'customer', 'Retail Co', '300 Shopping Center', 'Miami', 'USA')
) AS contact_data(name, email, phone, type, company, address, city, country)
ON CONFLICT DO NOTHING;

-- Insert dummy products
INSERT INTO public.products (organization_id, name, description, type, unit_price, cost_price, sku, tax_rate)
SELECT 
  org.id,
  product_data.name,
  product_data.description,
  product_data.type::product_type,
  product_data.unit_price,
  product_data.cost_price,
  product_data.sku,
  product_data.tax_rate
FROM public.organizations org
CROSS JOIN (VALUES
  ('Web Development Service', 'Custom website development', 'service', 150.00, 80.00, 'SVC-WEB-001', 10.0),
  ('Mobile App Development', 'iOS and Android app development', 'service', 200.00, 100.00, 'SVC-MOB-001', 10.0),
  ('Logo Design Package', 'Professional logo design with revisions', 'service', 500.00, 200.00, 'SVC-LOG-001', 10.0),
  ('Consulting Hour', 'Business consulting per hour', 'service', 175.00, 75.00, 'SVC-CON-001', 10.0),
  ('Laptop Computer', 'High-performance business laptop', 'product', 1299.00, 850.00, 'PRD-LAP-001', 8.0),
  ('Office Chair', 'Ergonomic office chair', 'product', 349.00, 180.00, 'PRD-CHR-001', 8.0),
  ('Software License', 'Annual software subscription', 'product', 299.00, 150.00, 'PRD-SFT-001', 0.0),
  ('Marketing Package', 'Complete marketing strategy', 'service', 2500.00, 1200.00, 'SVC-MKT-001', 10.0)
) AS product_data(name, description, type, unit_price, cost_price, sku, tax_rate)
ON CONFLICT DO NOTHING;

-- Insert dummy expense categories
INSERT INTO public.expense_categories (organization_id, name, description, color)
SELECT 
  org.id,
  cat_data.name,
  cat_data.description,
  cat_data.color
FROM public.organizations org
CROSS JOIN (VALUES
  ('Office Supplies', 'Pens, paper, and office materials', '#3B82F6'),
  ('Travel', 'Business travel expenses', '#10B981'),
  ('Software', 'Software subscriptions and licenses', '#8B5CF6'),
  ('Marketing', 'Advertising and promotional costs', '#F59E0B'),
  ('Utilities', 'Electricity, water, internet', '#EF4444'),
  ('Equipment', 'Office equipment and hardware', '#06B6D4'),
  ('Professional Services', 'Legal, accounting, consulting', '#EC4899'),
  ('Meals & Entertainment', 'Client meals and team events', '#84CC16')
) AS cat_data(name, description, color)
ON CONFLICT DO NOTHING;

-- Insert dummy invoices with various statuses and dates
INSERT INTO public.invoices (organization_id, invoice_number, contact_id, issue_date, due_date, status, subtotal, tax_amount, total, amount_paid, currency)
SELECT 
  org.id,
  'INV-2025-' || LPAD(row_number() OVER ()::text, 4, '0'),
  (SELECT id FROM public.contacts WHERE organization_id = org.id AND type IN ('customer', 'both') ORDER BY random() LIMIT 1),
  (CURRENT_DATE - (random() * 90)::int)::date,
  (CURRENT_DATE - (random() * 90)::int + 30)::date,
  (ARRAY['draft', 'sent', 'paid', 'partial', 'overdue'])[floor(random() * 5 + 1)]::invoice_status,
  inv_data.subtotal,
  inv_data.subtotal * 0.1,
  inv_data.subtotal * 1.1,
  CASE 
    WHEN random() > 0.5 THEN inv_data.subtotal * 1.1
    WHEN random() > 0.3 THEN inv_data.subtotal * 0.5
    ELSE 0
  END,
  'USD'
FROM public.organizations org
CROSS JOIN (VALUES
  (1500.00), (2300.00), (890.00), (4500.00), (1200.00),
  (3400.00), (780.00), (5600.00), (950.00), (2100.00),
  (1850.00), (3200.00), (670.00), (4100.00), (1950.00)
) AS inv_data(subtotal)
ON CONFLICT DO NOTHING;

-- Insert dummy expenses
INSERT INTO public.expenses (organization_id, description, amount, expense_date, status, category_id, vendor_id, currency, is_billable)
SELECT 
  org.id,
  exp_data.description,
  exp_data.amount,
  (CURRENT_DATE - (random() * 60)::int)::date,
  (ARRAY['pending', 'approved', 'paid'])[floor(random() * 3 + 1)]::expense_status,
  (SELECT id FROM public.expense_categories WHERE organization_id = org.id ORDER BY random() LIMIT 1),
  (SELECT id FROM public.contacts WHERE organization_id = org.id AND type IN ('vendor', 'both') ORDER BY random() LIMIT 1),
  'USD',
  random() > 0.7
FROM public.organizations org
CROSS JOIN (VALUES
  ('Office supplies purchase', 245.50),
  ('Team lunch meeting', 186.00),
  ('Software subscription - Adobe CC', 599.99),
  ('Business flight to NYC', 450.00),
  ('Conference registration', 299.00),
  ('Internet service - monthly', 89.99),
  ('Marketing materials printing', 325.00),
  ('Client dinner', 210.50),
  ('Office furniture', 890.00),
  ('Cloud hosting - AWS', 456.78),
  ('Legal consultation', 750.00),
  ('Equipment repair', 125.00),
  ('Parking fees', 45.00),
  ('Courier services', 67.50),
  ('Training workshop', 350.00)
) AS exp_data(description, amount)
ON CONFLICT DO NOTHING;

-- Insert dummy bills
INSERT INTO public.bills (organization_id, bill_number, vendor_id, bill_date, due_date, status, subtotal, tax_amount, total, amount_paid, currency)
SELECT 
  org.id,
  'BILL-2025-' || LPAD(row_number() OVER ()::text, 4, '0'),
  (SELECT id FROM public.contacts WHERE organization_id = org.id AND type IN ('vendor', 'both') ORDER BY random() LIMIT 1),
  (CURRENT_DATE - (random() * 60)::int)::date,
  (CURRENT_DATE - (random() * 60)::int + 30)::date,
  (ARRAY['draft', 'received', 'paid', 'partial', 'overdue'])[floor(random() * 5 + 1)]::bill_status,
  bill_data.subtotal,
  bill_data.subtotal * 0.08,
  bill_data.subtotal * 1.08,
  CASE 
    WHEN random() > 0.5 THEN bill_data.subtotal * 1.08
    ELSE 0
  END,
  'USD'
FROM public.organizations org
CROSS JOIN (VALUES
  (2500.00), (1800.00), (950.00), (3200.00), (1450.00),
  (2800.00), (720.00), (4100.00), (1100.00), (1650.00)
) AS bill_data(subtotal)
ON CONFLICT DO NOTHING;