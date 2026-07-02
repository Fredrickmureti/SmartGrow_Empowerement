import { BankTransaction, TransactionFilters } from '@/hooks/useBankTransactions';

// Mock Bank Account
export interface MockBankAccount {
  id: string;
  organization_id: string;
  name: string;
  bank_name: string;
  account_number: string;
  current_balance: number;
  is_active: boolean;
}

export const createMockBankAccount = (overrides: Partial<MockBankAccount> = {}): MockBankAccount => ({
  id: 'ba-1',
  organization_id: 'test-org-id',
  name: 'Main Business Account',
  bank_name: 'Equity Bank',
  account_number: '1234567890',
  current_balance: 500000,
  is_active: true,
  ...overrides,
});

// Mock Bank Transaction
export const createMockBankTransaction = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  lifecycle_status: "for_review" as const,
  id: 'bt-1',
  organization_id: 'test-org-id',
  bank_account_id: 'ba-1',
  external_transaction_id: 'ext-txn-001',
  transaction_date: '2024-01-15',
  posting_date: '2024-01-15',
  description: 'Payment from Customer ABC',
  reference: 'REF-001',
  amount: 50000,
  balance_after: 550000,
  transaction_type: 'credit',
  category: null,
  category_confidence: null,
  is_reconciled: false,
  reconciled_type: null,
  reconciled_entity_id: null,
  reconciled_at: null,
  reconciled_by: null,
  raw_data: {},
  ai_suggested_category: null,
  ai_confidence: null,
  ai_reasoning: null,
  journal_entry_id: null,
  created_at: '2024-01-15T10:00:00Z',
  updated_at: '2024-01-15T10:00:00Z',
  bank_account: {
    name: 'Main Business Account',
    bank_name: 'Equity Bank',
  },
  ...overrides,
});

// Mock Invoice for matching
export interface MockInvoice {
  id: string;
  invoice_number: string;
  total: number;
  amount_paid: number;
  due_date: string;
  contact: { name: string } | null;
}

export const createMockInvoice = (overrides: Partial<MockInvoice> = {}): MockInvoice => ({
  id: 'inv-1',
  invoice_number: 'INV-001',
  total: 50000,
  amount_paid: 0,
  due_date: '2024-01-30',
  contact: { name: 'Customer ABC' },
  ...overrides,
});

// Mock Bill for matching
export interface MockBill {
  id: string;
  bill_number: string;
  total: number;
  amount_paid: number;
  due_date: string;
  vendor: { name: string } | null;
}

export const createMockBill = (overrides: Partial<MockBill> = {}): MockBill => ({
  id: 'bill-1',
  bill_number: 'BILL-001',
  total: 25000,
  amount_paid: 0,
  due_date: '2024-01-25',
  vendor: { name: 'Supplier XYZ' },
  ...overrides,
});

// Pre-created mock data arrays
export const mockBankAccounts: MockBankAccount[] = [
  createMockBankAccount(),
  createMockBankAccount({
    id: 'ba-2',
    name: 'Savings Account',
    bank_name: 'KCB',
    account_number: '9876543210',
    current_balance: 1000000,
  }),
];

export const mockBankTransactions: BankTransaction[] = [
  createMockBankTransaction(),
  createMockBankTransaction({
    id: 'bt-2',
    external_transaction_id: 'ext-txn-002',
    description: 'Payment to Supplier XYZ',
    reference: 'REF-002',
    amount: -25000,
    balance_after: 525000,
    transaction_type: 'debit',
    transaction_date: '2024-01-16',
  }),
  createMockBankTransaction({
    id: 'bt-3',
    external_transaction_id: 'ext-txn-003',
    description: 'M-PESA Payment',
    reference: 'MPESA-12345',
    amount: 15000,
    balance_after: 540000,
    transaction_type: 'credit',
    is_reconciled: true,
    reconciled_type: 'invoice',
    reconciled_entity_id: 'inv-2',
    reconciled_at: '2024-01-17T12:00:00Z',
    transaction_date: '2024-01-17',
  }),
];

export const mockInvoices: MockInvoice[] = [
  createMockInvoice(),
  createMockInvoice({
    id: 'inv-2',
    invoice_number: 'INV-002',
    total: 15000,
    amount_paid: 15000,
    contact: { name: 'Customer DEF' },
  }),
];

export const mockBills: MockBill[] = [
  createMockBill(),
  createMockBill({
    id: 'bill-2',
    bill_number: 'BILL-002',
    total: 10000,
    vendor: { name: 'Supplier ABC' },
  }),
];

// Test scenarios for reconciliation
export const reconciliationTestCases = {
  perfectMatch: {
    transaction: createMockBankTransaction(),
    invoice: createMockInvoice(),
    expectedConfidence: 0.95,
  },
  amountMismatch: {
    transaction: createMockBankTransaction({ amount: 45000 }),
    invoice: createMockInvoice({ total: 50000 }),
    expectedConfidence: 0.7,
  },
  noMatch: {
    transaction: createMockBankTransaction({ 
      description: 'Unknown transfer', 
      amount: 12345 
    }),
    expectedConfidence: 0,
  },
};

// Stats calculation test data
export const statsTestData = {
  transactions: [
    createMockBankTransaction({ amount: 50000, transaction_type: 'credit', is_reconciled: true }),
    createMockBankTransaction({ id: 'bt-2', amount: 30000, transaction_type: 'credit', is_reconciled: false }),
    createMockBankTransaction({ id: 'bt-3', amount: -20000, transaction_type: 'debit', is_reconciled: true }),
    createMockBankTransaction({ id: 'bt-4', amount: -15000, transaction_type: 'debit', is_reconciled: false }),
  ],
  expectedStats: {
    totalTransactions: 4,
    reconciledCount: 2,
    unreconciledCount: 2,
    totalCredits: 80000,
    totalDebits: 35000,
  },
};
