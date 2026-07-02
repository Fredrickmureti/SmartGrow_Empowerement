
-- ========== CERTIFICATES ==========
INSERT INTO localization_pack_certificate_templates (pack_id, code, display_name, layout, body)
VALUES
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'P9', 'P9 — Tax Deduction Card',
 'ke_p9_landscape',
 jsonb_build_object(
   'sections', jsonb_build_array(
     jsonb_build_object('type','header','fields', jsonb_build_array(
       jsonb_build_object('label','Employer PIN','token','employer.tax_pin'),
       jsonb_build_object('label','Employer Name','token','employer.name'),
       jsonb_build_object('label','Employee PIN','token','employee.tax_pin'),
       jsonb_build_object('label','Employee Name','token','employee.full_name'),
       jsonb_build_object('label','National ID','token','employee.national_id'),
       jsonb_build_object('label','Fiscal Year','token','fiscal_year')
     )),
     jsonb_build_object('type','monthly_breakdown',
       'rule_codes', jsonb_build_array('basic_pay','gross_pay','nssf','shif','housing_levy','paye','personal_relief','insurance_relief'),
       'columns', jsonb_build_array(
         jsonb_build_object('key','month','header','Month','align','left'),
         jsonb_build_object('key','basic_pay','header','Basic Salary','align','right','format','money'),
         jsonb_build_object('key','gross_pay','header','Gross Pay','align','right','format','money'),
         jsonb_build_object('key','nssf','header','NSSF','align','right','format','money'),
         jsonb_build_object('key','shif','header','SHIF','align','right','format','money'),
         jsonb_build_object('key','housing_levy','header','AHL','align','right','format','money'),
         jsonb_build_object('key','taxable_pay','header','Taxable Pay','align','right','format','money'),
         jsonb_build_object('key','paye','header','PAYE','align','right','format','money'),
         jsonb_build_object('key','personal_relief','header','Personal Relief','align','right','format','money'),
         jsonb_build_object('key','insurance_relief','header','Insurance Relief','align','right','format','money'),
         jsonb_build_object('key','net_paye','header','Net PAYE','align','right','format','money')
       ))
   ),
   'footer', jsonb_build_object('blocks', jsonb_build_array(
     jsonb_build_object('type','note','text','I certify that the information given on this card is correct. — Employer Signature'),
     jsonb_build_object('type','note','text','KRA P9 Tax Deduction Card — issued under the Income Tax Act, Cap 470.')
   ))
 )),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'P9A', 'P9A — Tax Deduction Card (Low Income)',
 'ke_p9_landscape',
 jsonb_build_object(
   'sections', jsonb_build_array(
     jsonb_build_object('type','header','fields', jsonb_build_array(
       jsonb_build_object('label','Employer PIN','token','employer.tax_pin'),
       jsonb_build_object('label','Employee PIN','token','employee.tax_pin'),
       jsonb_build_object('label','Employee Name','token','employee.full_name'),
       jsonb_build_object('label','Fiscal Year','token','fiscal_year')
     )),
     jsonb_build_object('type','monthly_breakdown',
       'rule_codes', jsonb_build_array('basic_pay','gross_pay','paye','personal_relief'),
       'columns', jsonb_build_array(
         jsonb_build_object('key','month','header','Month','align','left'),
         jsonb_build_object('key','basic_pay','header','Basic Salary','align','right','format','money'),
         jsonb_build_object('key','gross_pay','header','Gross Pay','align','right','format','money'),
         jsonb_build_object('key','paye','header','PAYE','align','right','format','money'),
         jsonb_build_object('key','personal_relief','header','Personal Relief','align','right','format','money'),
         jsonb_build_object('key','net_paye','header','Net PAYE','align','right','format','money')
       ))
   )
 ));

-- ========== RETURNS ==========
INSERT INTO localization_pack_return_templates
  (pack_id, code, display_name, description, authority_name, period, output, body, due_day, due_month_offset, sort_order, submission_format)
VALUES
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','P10','P10 — Monthly PAYE Return (iTax CSV)',
 'Monthly PAYE return submitted to KRA via iTax portal.','Kenya Revenue Authority','monthly','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('paye')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','employee_pin','label','PIN of Employee','source','employee.tax_pin'),
     jsonb_build_object('key','employee_name','label','Name of Employee','source','employee.full_name'),
     jsonb_build_object('key','residential_status','label','Residential Status','source','constant.RESIDENT'),
     jsonb_build_object('key','employee_type','label','Type of Employee','source','constant.PRIMARY'),
     jsonb_build_object('key','basic_salary','label','Basic Salary','source','sum_basic_pay'),
     jsonb_build_object('key','allowances','label','Allowances','source','sum_allowances'),
     jsonb_build_object('key','gross_pay','label','Gross Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','nssf','label','NSSF','source','sum_rule.nssf.employee'),
     jsonb_build_object('key','shif','label','SHIF','source','sum_rule.shif.employee'),
     jsonb_build_object('key','ahl','label','AHL','source','sum_rule.housing_levy.employee'),
     jsonb_build_object('key','taxable_pay','label','Taxable Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','paye','label','PAYE Tax (Kshs)','source','sum_employee_amount'),
     jsonb_build_object('key','personal_relief','label','Personal Relief','source','sum_rule.personal_relief.employee'),
     jsonb_build_object('key','insurance_relief','label','Insurance Relief','source','sum_rule.insurance_relief.employee'),
     jsonb_build_object('key','paye_payable','label','PAYE Payable','source','sum_employee_amount')
   ),
   'totals', jsonb_build_array('gross_pay','paye','nssf','shif','ahl','paye_payable'),
   'reconciliation', jsonb_build_object('rule_code','paye','against','payroll_liabilities.original_amount')
 ),
 9, 1, 10, jsonb_build_object('format','itax_csv','portal','iTax')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','P10A','P10A — Monthly PAYE Detail Register',
 'Detailed PAYE register PDF supporting the P10 filing.','Kenya Revenue Authority','monthly','pdf',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('paye')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','employee_pin','label','Employee PIN','source','employee.tax_pin'),
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','gross_pay','label','Gross Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','taxable_pay','label','Taxable Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','paye','label','PAYE','source','sum_employee_amount')
   ),
   'totals', jsonb_build_array('gross_pay','taxable_pay','paye'),
   'reconciliation', jsonb_build_object('rule_code','paye','against','payroll_liabilities.original_amount')
 ),
 9, 1, 11, jsonb_build_object('format','pdf','portal','internal')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','P10D','P10D — Annual PAYE Reconciliation',
 'Annual PAYE reconciliation submitted to KRA.','Kenya Revenue Authority','annual','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('paye')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','employee_pin','label','Employee PIN','source','employee.tax_pin'),
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','gross_pay_ytd','label','Annual Gross Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','paye_ytd','label','Annual PAYE','source','sum_employee_amount')
   ),
   'totals', jsonb_build_array('gross_pay_ytd','paye_ytd'),
   'reconciliation', jsonb_build_object('rule_code','paye','against','payroll_liabilities.original_amount')
 ),
 28, 2, 12, jsonb_build_object('format','itax_csv','portal','iTax')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','NSSF_RET','NSSF Monthly Byproduct Return',
 'Monthly NSSF contribution return submitted via NSSF self-service portal.','National Social Security Fund','monthly','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('nssf')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','nssf_number','label','NSSF Number','source','employee.statutory_id.nssf'),
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','national_id','label','National ID','source','employee.national_id'),
     jsonb_build_object('key','gross_pay','label','Pensionable Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','employee_contribution','label','Employee Contribution','source','sum_employee_amount'),
     jsonb_build_object('key','employer_contribution','label','Employer Contribution','source','sum_employer_amount'),
     jsonb_build_object('key','total','label','Total','source','sum_total_amount')
   ),
   'totals', jsonb_build_array('gross_pay','employee_contribution','employer_contribution','total'),
   'reconciliation', jsonb_build_object('rule_code','nssf','against','payroll_liabilities.original_amount')
 ),
 9, 1, 20, jsonb_build_object('format','nssf_csv','portal','NSSF Self-Service')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','SHIF_RET','SHIF Monthly Byproduct Return',
 'Monthly SHIF contribution return submitted via SHA portal.','Social Health Authority','monthly','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('shif')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','sha_number','label','SHA Number','source','employee.statutory_id.shif'),
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','national_id','label','National ID','source','employee.national_id'),
     jsonb_build_object('key','gross_pay','label','Gross Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','employee_contribution','label','Employee Contribution','source','sum_employee_amount')
   ),
   'totals', jsonb_build_array('gross_pay','employee_contribution'),
   'reconciliation', jsonb_build_object('rule_code','shif','against','payroll_liabilities.original_amount')
 ),
 9, 1, 21, jsonb_build_object('format','sha_csv','portal','SHA')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','AHL_RET','AHL Monthly Byproduct Return',
 'Monthly Affordable Housing Levy return submitted via KRA iTax.','Kenya Revenue Authority','monthly','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('housing_levy')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','employee_pin','label','Employee PIN','source','employee.tax_pin'),
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','gross_pay','label','Gross Pay','source','sum_taxable_amount'),
     jsonb_build_object('key','employee_contribution','label','Employee AHL','source','sum_employee_amount'),
     jsonb_build_object('key','employer_contribution','label','Employer AHL','source','sum_employer_amount'),
     jsonb_build_object('key','total','label','Total AHL','source','sum_total_amount')
   ),
   'totals', jsonb_build_array('gross_pay','employee_contribution','employer_contribution','total'),
   'reconciliation', jsonb_build_object('rule_code','housing_levy','against','payroll_liabilities.original_amount')
 ),
 9, 1, 22, jsonb_build_object('format','itax_csv','portal','iTax')),

('a1b2c3d4-e5f6-7890-abcd-ef1234567890','NITA_RET','NITA Annual Contribution Return',
 'Annual NITA employer contribution return.','National Industrial Training Authority','annual','csv',
 jsonb_build_object(
   'filters', jsonb_build_object('payslip_status', jsonb_build_array('validated','paid'), 'rule_codes', jsonb_build_array('nita')),
   'group_by', jsonb_build_array('employee_id'),
   'columns', jsonb_build_array(
     jsonb_build_object('key','employee_name','label','Employee Name','source','employee.full_name'),
     jsonb_build_object('key','national_id','label','National ID','source','employee.national_id'),
     jsonb_build_object('key','months_employed','label','Months Employed','source','count_payslips'),
     jsonb_build_object('key','employer_contribution','label','Employer NITA','source','sum_employer_amount')
   ),
   'totals', jsonb_build_array('employer_contribution'),
   'reconciliation', jsonb_build_object('rule_code','nita','against','payroll_liabilities.original_amount')
 ),
 10, 1, 23, jsonb_build_object('format','nita_csv','portal','NITA Portal'));

-- ========== REMITTANCE SCHEDULES ==========
INSERT INTO localization_pack_remittance_schedules (pack_id, rule_code, authority_name, frequency, due_day, liability_account_setting_key)
VALUES
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','paye','Kenya Revenue Authority','monthly',9,'payroll.liability.paye'),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','nssf','National Social Security Fund','monthly',9,'payroll.liability.nssf'),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','shif','Social Health Authority','monthly',9,'payroll.liability.shif'),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','housing_levy','Kenya Revenue Authority','monthly',9,'payroll.liability.housing_levy'),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890','nita','National Industrial Training Authority','monthly',9,'payroll.liability.nita')
ON CONFLICT DO NOTHING;
