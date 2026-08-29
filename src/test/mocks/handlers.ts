import { http, HttpResponse } from 'msw';
import { 
  mockPayrollRuns, 
  mockPayslips, 
  mockEmployees 
} from '../factories/payroll.factory';
import { 
  mockBankTransactions, 
  mockBankAccounts,
  mockInvoices,
  mockBills,
} from '../factories/bankTransactions.factory';

const SUPABASE_URL = 'https://xwxqunklduknceoryrha.supabase.co';

// Base handlers (will be overridden by more specific handlers)
const baseHandlers = [
  // ============ PAYROLL HANDLERS ============
  http.get(`${SUPABASE_URL}/rest/v1/payroll_runs*`, () => {
    return HttpResponse.json(mockPayrollRuns);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/payroll_runs`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      id: 'new-payroll-run-id',
      ...body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/payroll_runs*`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ ...mockPayrollRuns[0], ...body });
  }),

  http.delete(`${SUPABASE_URL}/rest/v1/payroll_runs*`, () => {
    return HttpResponse.json({});
  }),

  http.get(`${SUPABASE_URL}/rest/v1/payslips*`, () => {
    return HttpResponse.json(mockPayslips);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/payslips`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json(body);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/employees*`, () => {
    return HttpResponse.json(mockEmployees);
  }),

  // ============ BANK TRANSACTION HANDLERS ============
  http.get(`${SUPABASE_URL}/rest/v1/bank_transactions*`, () => {
    return HttpResponse.json(mockBankTransactions);
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/bank_transactions*`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ ...mockBankTransactions[0], ...body });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/bank_accounts*`, () => {
    return HttpResponse.json(mockBankAccounts);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/invoices*`, () => {
    return HttpResponse.json(mockInvoices);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/bills*`, () => {
    return HttpResponse.json(mockBills);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/expenses*`, () => {
    return HttpResponse.json([]);
  }),

  // ============ EDGE FUNCTIONS ============
  http.post(`${SUPABASE_URL}/functions/v1/ai-assistant`, () => {
    return HttpResponse.json({
      data: {
        matches: [
          {
            transaction_id: 'bt-1',
            matched_entity_id: 'inv-1',
            matched_type: 'invoice',
            confidence: 0.85,
            reasoning: 'Amount and date match invoice INV-001',
          },
        ],
      },
    });
  }),

  // ============ RPC HANDLERS ============
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_next_payroll_number`, () => {
    return HttpResponse.json('PAY-0002');
  }),

  // ============ AUTH HANDLERS ============
  http.get(`${SUPABASE_URL}/auth/v1/user`, () => {
    return HttpResponse.json({
      user: {
        id: 'test-user-id',
        email: 'test@example.com',
      },
    });
  }),
];

export const handlers = [...baseHandlers];
