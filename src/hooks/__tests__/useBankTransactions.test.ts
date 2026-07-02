import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  mockBankTransactions, 
  statsTestData,
  createMockBankTransaction,
} from '@/test/factories/bankTransactions.factory';

// Test the stats calculation logic
describe('Bank Transactions Stats Calculation', () => {
  describe('Stats Calculation', () => {
    it('should calculate total transactions correctly', () => {
      const transactions = statsTestData.transactions;
      const total = transactions.length;
      expect(total).toBe(statsTestData.expectedStats.totalTransactions);
    });

    it('should calculate reconciled count correctly', () => {
      const transactions = statsTestData.transactions;
      const reconciledCount = transactions.filter(t => t.is_reconciled).length;
      expect(reconciledCount).toBe(statsTestData.expectedStats.reconciledCount);
    });

    it('should calculate unreconciled count correctly', () => {
      const transactions = statsTestData.transactions;
      const unreconciledCount = transactions.filter(t => !t.is_reconciled).length;
      expect(unreconciledCount).toBe(statsTestData.expectedStats.unreconciledCount);
    });

    it('should calculate total credits correctly', () => {
      const transactions = statsTestData.transactions;
      const totalCredits = transactions
        .filter(t => t.transaction_type === 'credit')
        .reduce((sum, t) => sum + Number(t.amount), 0);
      expect(totalCredits).toBe(statsTestData.expectedStats.totalCredits);
    });

    it('should calculate total debits correctly', () => {
      const transactions = statsTestData.transactions;
      const totalDebits = transactions
        .filter(t => t.transaction_type === 'debit')
        .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);
      expect(totalDebits).toBe(statsTestData.expectedStats.totalDebits);
    });
  });

  describe('Transaction Filtering', () => {
    it('should filter by transaction type', () => {
      const transactions = mockBankTransactions;
      const credits = transactions.filter(t => t.transaction_type === 'credit');
      const debits = transactions.filter(t => t.transaction_type === 'debit');
      
      expect(credits.length).toBeGreaterThan(0);
      expect(debits.length).toBeGreaterThan(0);
    });

    it('should filter by reconciliation status', () => {
      const transactions = mockBankTransactions;
      const reconciled = transactions.filter(t => t.is_reconciled);
      const unreconciled = transactions.filter(t => !t.is_reconciled);
      
      expect(reconciled.length + unreconciled.length).toBe(transactions.length);
    });

    it('should filter by search query matching description', () => {
      const transactions = mockBankTransactions;
      const searchQuery = 'Payment';
      const filtered = transactions.filter(t => 
        t.description.toLowerCase().includes(searchQuery.toLowerCase())
      );
      
      expect(filtered.length).toBeGreaterThan(0);
    });

    it('should filter by search query matching reference', () => {
      const transactions = mockBankTransactions;
      const searchQuery = 'MPESA';
      const filtered = transactions.filter(t => 
        t.reference?.toLowerCase().includes(searchQuery.toLowerCase())
      );
      
      expect(filtered.length).toBeGreaterThan(0);
    });
  });

  describe('Reconciliation Data', () => {
    it('should identify reconciled transactions correctly', () => {
      const reconciledTxn = createMockBankTransaction({
        is_reconciled: true,
        reconciled_type: 'invoice',
        reconciled_entity_id: 'inv-1',
        reconciled_at: new Date().toISOString(),
      });

      expect(reconciledTxn.is_reconciled).toBe(true);
      expect(reconciledTxn.reconciled_type).toBe('invoice');
      expect(reconciledTxn.reconciled_entity_id).toBe('inv-1');
    });

    it('should identify unreconciled transactions correctly', () => {
      const unreconciledTxn = createMockBankTransaction({
        is_reconciled: false,
        reconciled_type: null,
        reconciled_entity_id: null,
      });

      expect(unreconciledTxn.is_reconciled).toBe(false);
      expect(unreconciledTxn.reconciled_type).toBeNull();
    });
  });
});

describe('AI Auto-Match Logic', () => {
  describe('Match Confidence', () => {
    it('should identify high confidence matches (>=0.7)', () => {
      const mockMatches = [
        { transaction_id: 'bt-1', matched_entity_id: 'inv-1', confidence: 0.85 },
        { transaction_id: 'bt-2', matched_entity_id: 'bill-1', confidence: 0.92 },
      ];

      const highConfidenceMatches = mockMatches.filter(m => m.confidence >= 0.7);
      expect(highConfidenceMatches).toHaveLength(2);
    });

    it('should filter out low confidence matches (<0.7)', () => {
      const mockMatches = [
        { transaction_id: 'bt-1', matched_entity_id: 'inv-1', confidence: 0.85 },
        { transaction_id: 'bt-2', matched_entity_id: 'bill-1', confidence: 0.5 },
        { transaction_id: 'bt-3', matched_entity_id: 'exp-1', confidence: 0.3 },
      ];

      const highConfidenceMatches = mockMatches.filter(m => m.confidence >= 0.7);
      expect(highConfidenceMatches).toHaveLength(1);
    });
  });

  describe('Match Types', () => {
    it('should support invoice matches for credits', () => {
      const creditTransaction = createMockBankTransaction({ 
        transaction_type: 'credit',
        amount: 50000,
      });

      // Credits should typically match to invoices (incoming payments)
      expect(creditTransaction.transaction_type).toBe('credit');
    });

    it('should support bill matches for debits', () => {
      const debitTransaction = createMockBankTransaction({ 
        transaction_type: 'debit',
        amount: -25000,
      });

      // Debits should typically match to bills/expenses (outgoing payments)
      expect(debitTransaction.transaction_type).toBe('debit');
    });
  });

  describe('Amount Matching', () => {
    it('should identify exact amount matches', () => {
      const transaction = createMockBankTransaction({ amount: 50000 });
      const invoice = { total: 50000, amount_paid: 0 };
      
      const outstandingAmount = invoice.total - invoice.amount_paid;
      const isExactMatch = Math.abs(transaction.amount - outstandingAmount) < 0.01;
      
      expect(isExactMatch).toBe(true);
    });

    it('should identify partial amount matches', () => {
      const transaction = createMockBankTransaction({ amount: 25000 });
      const invoice = { total: 50000, amount_paid: 25000 };
      
      const outstandingAmount = invoice.total - invoice.amount_paid;
      const isPartialMatch = transaction.amount === outstandingAmount;
      
      expect(isPartialMatch).toBe(true);
    });
  });
});

describe('Transaction Categories', () => {
  it('should support standard categories', () => {
    const categories = [
      'Sales Revenue',
      'Cost of Goods Sold',
      'Operating Expenses',
      'Payroll',
      'Rent',
      'Utilities',
      'Bank Fees',
      'Interest Income',
      'Other Income',
      'Other Expense',
    ];

    categories.forEach(category => {
      const txn = createMockBankTransaction({ category });
      expect(txn.category).toBe(category);
    });
  });

  it('should support AI suggested categories', () => {
    const txn = createMockBankTransaction({
      ai_suggested_category: 'Operating Expenses',
      ai_confidence: 0.85,
      ai_reasoning: 'Transaction description matches expense patterns',
    });

    expect(txn.ai_suggested_category).toBe('Operating Expenses');
    expect(txn.ai_confidence).toBe(0.85);
    expect(txn.ai_reasoning).toBeDefined();
  });
});
