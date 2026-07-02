
INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('garnishment_admin_fee_employer_expense', 'Garnishment Admin Fee — Employer Expense',
   'Expense the employer recognizes for processing each garnishment order (per-kind employer fee).',
   'expense', false, 'payroll', 250),
  ('garnishment_admin_fee_payable', 'Garnishment Admin Fee — Payable',
   'Liability for unremitted employer admin fees on garnishment orders.',
   'liability', false, 'payroll', 251)
ON CONFLICT (role_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  required_account_type = EXCLUDED.required_account_type,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order;
