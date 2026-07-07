
INSERT INTO public.system_account_roles
 (role_key, label, description, required_account_type, category, is_mandatory, sort_order)
VALUES
 ('ssnit_payable',           'Statutory Pension Tier 1 Payable',    'Country-agnostic Tier-1 social-security liability (Ghana SSNIT, Kenya NSSF Tier 1, etc.).', 'liability', 'payroll', false, 260),
 ('tier2_payable',           'Statutory Pension Tier 2 Payable',    'Mandatory Tier-2 pension liability routed to a licensed trustee (Ghana NPRA, Kenya NSSF Tier 2).', 'liability', 'payroll', false, 261),
 ('tier3_payable',           'Voluntary Pension Tier 3 Payable',    'Voluntary Tier-3 pension liability (employee and/or employer).', 'liability', 'payroll', false, 262),
 ('sltf_payable',            'Student Loan Trust Fund Payable',     'Student loan / education-fund deduction payable, remitted monthly to the loan authority.', 'liability', 'payroll', false, 270),
 ('employer_ssnit_expense',  'Employer Statutory Pension Expense',  'Employer-side social-security / pension cost recognised on payroll post.', 'expense', 'payroll', false, 175)
ON CONFLICT (role_key) DO NOTHING;
