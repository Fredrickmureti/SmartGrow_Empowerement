import { PayrollRun, Payslip } from '@/hooks/usePayroll';
import { Employee } from '@/hooks/useEmployees';

// Mock Employees
export const createMockEmployee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 'emp-1',
  organization_id: 'test-org-id',
  employee_number: 'EMP-001',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john.doe@example.com',
  phone: '+254700000000',
  national_id: '12345678',
  // Statutory identifiers now live in `employee_statutory_identifiers`
  // (see useEmployeeStatutoryIdentifiers); legacy typed columns retired.
  hire_date: '2023-01-15',
  termination_date: null,
  department: 'Engineering',
  position: 'Software Engineer',
  employment_type: 'full_time',
  bank_name: 'Equity Bank',
  bank_branch: 'Nairobi',
  bank_account_number: '1234567890',
  bank_code: '068',
  basic_salary: 50000,
  housing_allowance: 10000,
  transport_allowance: 5000,
  other_allowances: { meal: 2000 },
  is_active: true,
  created_at: '2023-01-15T00:00:00Z',
  updated_at: '2023-01-15T00:00:00Z',
  // ERP fields
  user_id: null,
  manager_id: null,
  department_id: null,
  emergency_contact_relationship: null,
  marital_status: null,
  address_line1: null,
  address_line2: null,
  city: null,
  county: null,
  postal_code: null,
  country: null,
  ...overrides,
});

// Mock Payroll Runs
export const createMockPayrollRun = (overrides: Partial<PayrollRun> = {}): PayrollRun => ({
  created_by: null,
  id: 'pr-1',
  organization_id: 'test-org-id',
  payroll_number: 'PAY-0001',
  pay_period_start: '2024-01-01',
  pay_period_end: '2024-01-31',
  payment_date: null,
  status: 'draft',
  total_gross: 67000,
  total_other_deductions: 13398,
  total_net: 53602,
  total_employer_contributions: 2160,
  employee_count: 1,
  notes: null,
  approved_by: null,
  approved_at: null,
  created_at: '2024-01-31T00:00:00Z',
  updated_at: '2024-01-31T00:00:00Z',
  deductions_summary: { paye: 8533, nssf: 2160, nhif: 1700, housing_levy: 1005 },
  contributions_summary: { nssf: 2160 },
  ...overrides,
});

// Mock Payslips
// Phase 4 P1.2c: header carries only universal totals + lineage.
// Per-component decomposition is modelled in payslip_lines (not seeded
// here — tests that exercise lines build them via createMockPayslipLine).
export const createMockPayslip = (overrides: Partial<Payslip> = {}): Payslip => ({
  id: 'ps-1',
  payroll_run_id: 'pr-1',
  employee_id: 'emp-1',
  organization_id: 'test-org-id',
  gross_pay: 67000,
  total_deductions: 13398,
  net_pay: 53602,
  status: 'pending',
  paid_at: null,
  payment_reference: null,
  deductions_detail: { paye: 8533, nssf: 2160, nhif: 1700, housing_levy: 1005 },
  contributions_detail: { nssf: 2160 },
  ...overrides,
});

// Pre-created mock data arrays
export const mockEmployees: Employee[] = [
  createMockEmployee(),
  createMockEmployee({
    id: 'emp-2',
    employee_number: 'EMP-002',
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane.smith@example.com',
    basic_salary: 80000,
    housing_allowance: 15000,
    transport_allowance: 8000,
  }),
];

export const mockPayrollRuns: PayrollRun[] = [
  createMockPayrollRun(),
  createMockPayrollRun({
    id: 'pr-2',
    payroll_number: 'PAY-0002',
    pay_period_start: '2024-02-01',
    pay_period_end: '2024-02-29',
    status: 'approved',
    approved_by: 'test-user-id',
    approved_at: '2024-02-28T12:00:00Z',
  }),
];

export const mockPayslips: Payslip[] = [
  createMockPayslip(),
  createMockPayslip({
    id: 'ps-2',
    employee_id: 'emp-2',
    gross_pay: 103000,
  }),
];

// Test case scenarios for PAYE calculations
export const payeTestCases = [
  { gross: 20000, expected: 0, description: 'Below first bracket with relief' },
  { gross: 30000, expected: 1100, description: 'First bracket' },
  { gross: 50000, expected: 5533, description: 'Second bracket' },
  { gross: 100000, expected: 20533, description: 'Third bracket' },
  { gross: 600000, expected: 170533, description: 'Fourth bracket' },
  { gross: 1000000, expected: 310533, description: 'Fifth bracket (highest)' },
];

// Test case scenarios for NHIF calculations
export const nhifTestCases = [
  { gross: 5000, expected: 150 },
  { gross: 7000, expected: 300 },
  { gross: 10000, expected: 400 },
  { gross: 15000, expected: 500 },
  { gross: 20000, expected: 600 },
  { gross: 30000, expected: 850 },
  { gross: 50000, expected: 1100 },
  { gross: 80000, expected: 1400 },
  { gross: 100000, expected: 1700 },
];

// Test case scenarios for NSSF calculations
export const nssfTestCases = [
  { gross: 5000, expected: { employee: 300, employer: 300 } },
  { gross: 7000, expected: { employee: 420, employer: 420 } },
  { gross: 20000, expected: { employee: 1200, employer: 1200 } },
  { gross: 36000, expected: { employee: 2160, employer: 2160 } },
  { gross: 50000, expected: { employee: 2160, employer: 2160 } }, // Capped
];

// Test case scenarios for Housing Levy
export const housingLevyTestCases = [
  { gross: 50000, expected: 750 },
  { gross: 100000, expected: 1500 },
  { gross: 200000, expected: 3000 },
];
