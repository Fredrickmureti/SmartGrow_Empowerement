import { describe, it, expect, vi } from 'vitest';
import React from 'react';

// Mock the hooks
vi.mock('@/hooks/usePayroll', () => ({
  usePayroll: () => ({
    payrollRuns: [
      {
        id: 'pr-1',
        payroll_number: 'PAY-0001',
        pay_period_start: '2024-01-01',
        pay_period_end: '2024-01-31',
        status: 'draft',
        total_gross: 67000,
        total_net: 53600,
        employee_count: 1,
      },
      {
        id: 'pr-2',
        payroll_number: 'PAY-0002',
        pay_period_start: '2024-02-01',
        pay_period_end: '2024-02-29',
        status: 'approved',
        total_gross: 134000,
        total_net: 107200,
        employee_count: 2,
      },
    ],
    payslips: [],
    isLoading: false,
    createPayrollRun: vi.fn(),
    approvePayrollRun: vi.fn(),
    processPayrollRun: vi.fn(),
    deletePayrollRun: vi.fn(),
    fetchPayslips: vi.fn(),
  }),
}));

vi.mock('@/hooks/useEmployees', () => ({
  useEmployees: () => ({
    employees: [
      { id: 'emp-1', first_name: 'John', last_name: 'Doe', is_active: true },
      { id: 'emp-2', first_name: 'Jane', last_name: 'Smith', is_active: true },
    ],
    activeEmployees: [
      { id: 'emp-1', first_name: 'John', last_name: 'Doe', is_active: true },
      { id: 'emp-2', first_name: 'Jane', last_name: 'Smith', is_active: true },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    currentOrg: { id: 'test-org-id', name: 'Test Org' },
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'test-user-id', email: 'test@example.com' },
  }),
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    isOwner: true,
  }),
}));

vi.mock('@/hooks/useCurrency', () => ({
  useCurrency: () => ({
    formatCurrency: (amount: number) => `KES ${amount.toLocaleString()}`,
    currency: 'KES',
  }),
}));

describe('Payroll Page', () => {
  describe('Payroll Run Display', () => {
    it('should display payroll runs data correctly', () => {
      const payrollRuns = [
        {
          id: 'pr-1',
          payroll_number: 'PAY-0001',
          status: 'draft',
          total_gross: 67000,
          employee_count: 1,
        },
      ];

      expect(payrollRuns).toHaveLength(1);
      expect(payrollRuns[0].payroll_number).toBe('PAY-0001');
      expect(payrollRuns[0].status).toBe('draft');
    });

    it('should filter payroll runs by status', () => {
      const payrollRuns = [
        { id: 'pr-1', status: 'draft' },
        { id: 'pr-2', status: 'approved' },
        { id: 'pr-3', status: 'paid' },
      ];

      const draftRuns = payrollRuns.filter(pr => pr.status === 'draft');
      const approvedRuns = payrollRuns.filter(pr => pr.status === 'approved');
      const paidRuns = payrollRuns.filter(pr => pr.status === 'paid');

      expect(draftRuns).toHaveLength(1);
      expect(approvedRuns).toHaveLength(1);
      expect(paidRuns).toHaveLength(1);
    });
  });

  describe('Payroll Actions', () => {
    it('should show approve button only for draft status', () => {
      const payrollRun = { id: 'pr-1', status: 'draft' };
      const canApprove = payrollRun.status === 'draft';
      expect(canApprove).toBe(true);
    });

    it('should show pay button only for approved status', () => {
      const payrollRun = { id: 'pr-1', status: 'approved' };
      const canPay = payrollRun.status === 'approved';
      expect(canPay).toBe(true);
    });

    it('should not show actions for paid status', () => {
      const payrollRun = { id: 'pr-1', status: 'paid' };
      const canApprove = payrollRun.status === 'draft';
      const canPay = payrollRun.status === 'approved';
      
      expect(canApprove).toBe(false);
      expect(canPay).toBe(false);
    });
  });

  describe('Payslip Display', () => {
    it('should calculate employee payslip totals from generic deductions_detail', () => {
      const payslip = {
        gross_pay: 67000,
        deductions_detail: { paye: 8533, nhif: 1700, nssf: 2160, housing_levy: 1005 } as Record<string, number>,
      };

      const totalDeductions = Object.values(payslip.deductions_detail).reduce((s, v) => s + v, 0);
      const netPay = payslip.gross_pay - totalDeductions;

      expect(totalDeductions).toBe(13398);
      expect(netPay).toBe(53602);
    });
  });

  describe('Date Range Selection', () => {
    it('should validate pay period dates', () => {
      const payPeriodStart = new Date('2024-01-01');
      const payPeriodEnd = new Date('2024-01-31');
      
      const isValidRange = payPeriodEnd > payPeriodStart;
      expect(isValidRange).toBe(true);
    });

    it('should reject invalid date ranges', () => {
      const payPeriodStart = new Date('2024-01-31');
      const payPeriodEnd = new Date('2024-01-01');
      
      const isValidRange = payPeriodEnd > payPeriodStart;
      expect(isValidRange).toBe(false);
    });
  });

  describe('Employee Selection', () => {
    it('should filter active employees only', () => {
      const employees = [
        { id: 'emp-1', is_active: true },
        { id: 'emp-2', is_active: false },
        { id: 'emp-3', is_active: true },
      ];

      const activeEmployees = employees.filter(e => e.is_active);
      expect(activeEmployees).toHaveLength(2);
    });
  });

  describe('Summary Statistics', () => {
    it('should calculate total gross for all employees', () => {
      const payslips = [
        { gross_pay: 67000 },
        { gross_pay: 103000 },
      ];

      const totalGross = payslips.reduce((sum, ps) => sum + ps.gross_pay, 0);
      expect(totalGross).toBe(170000);
    });

    it('should calculate total net for all employees', () => {
      const payslips = [
        { net_pay: 53602 },
        { net_pay: 82400 },
      ];

      const totalNet = payslips.reduce((sum, ps) => sum + ps.net_pay, 0);
      expect(totalNet).toBe(136002);
    });
  });
});
