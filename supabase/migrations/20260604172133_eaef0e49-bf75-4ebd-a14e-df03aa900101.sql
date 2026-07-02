INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES ('employer_nita_expense', 'Employer NITA Expense',
        'Employer-only NITA training levy (Kenya). Re-registered globally because the pack installer does not seed system_account_roles; the prior cleanup that removed this role broke statutory rule validation.',
        'expense', false, 'payroll', 670)
ON CONFLICT (role_key) DO NOTHING;