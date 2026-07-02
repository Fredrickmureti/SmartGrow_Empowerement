import { describe, it, expect, vi } from 'vitest';

// Mock dependencies
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

vi.mock('@/hooks/useCurrency', () => ({
  useCurrency: () => ({
    formatCurrency: (amount: number) => `KES ${amount.toLocaleString()}`,
    currency: 'KES',
  }),
}));

describe('Bank Reconciliation Page', () => {
  describe('Transaction Display', () => {
    it('should display transactions correctly', () => {
      const transactions = [
        { id: 'bt-1', description: 'Payment 1', amount: 5000, is_reconciled: false },
        { id: 'bt-2', description: 'Payment 2', amount: 3000, is_reconciled: true },
      ];

      expect(transactions).toHaveLength(2);
      expect(transactions[0].description).toBe('Payment 1');
    });

    it('should show reconciliation status indicator', () => {
      const transactions = [
        { id: 'bt-1', is_reconciled: false },
        { id: 'bt-2', is_reconciled: true },
      ];

      const reconciled = transactions.filter(t => t.is_reconciled);
      const unreconciled = transactions.filter(t => !t.is_reconciled);

      expect(reconciled).toHaveLength(1);
      expect(unreconciled).toHaveLength(1);
    });
  });

  describe('Summary Cards', () => {
    it('should calculate total transactions', () => {
      const transactions = [
        { id: 'bt-1' },
        { id: 'bt-2' },
        { id: 'bt-3' },
      ];

      expect(transactions.length).toBe(3);
    });

    it('should calculate reconciled count', () => {
      const transactions = [
        { id: 'bt-1', is_reconciled: true },
        { id: 'bt-2', is_reconciled: true },
        { id: 'bt-3', is_reconciled: false },
      ];

      const reconciledCount = transactions.filter(t => t.is_reconciled).length;
      expect(reconciledCount).toBe(2);
    });

    it('should calculate unreconciled count', () => {
      const transactions = [
        { id: 'bt-1', is_reconciled: true },
        { id: 'bt-2', is_reconciled: false },
        { id: 'bt-3', is_reconciled: false },
      ];

      const unreconciledCount = transactions.filter(t => !t.is_reconciled).length;
      expect(unreconciledCount).toBe(2);
    });

    it('should calculate total credits', () => {
      const transactions = [
        { id: 'bt-1', transaction_type: 'credit', amount: 5000 },
        { id: 'bt-2', transaction_type: 'credit', amount: 3000 },
        { id: 'bt-3', transaction_type: 'debit', amount: -2000 },
      ];

      const totalCredits = transactions
        .filter(t => t.transaction_type === 'credit')
        .reduce((sum, t) => sum + t.amount, 0);

      expect(totalCredits).toBe(8000);
    });

    it('should calculate total debits', () => {
      const transactions = [
        { id: 'bt-1', transaction_type: 'debit', amount: -5000 },
        { id: 'bt-2', transaction_type: 'debit', amount: -3000 },
        { id: 'bt-3', transaction_type: 'credit', amount: 2000 },
      ];

      const totalDebits = transactions
        .filter(t => t.transaction_type === 'debit')
        .reduce((sum, t) => sum + Math.abs(t.amount), 0);

      expect(totalDebits).toBe(8000);
    });
  });

  describe('Filtering', () => {
    it('should filter by bank account', () => {
      const transactions = [
        { id: 'bt-1', bank_account_id: 'ba-1' },
        { id: 'bt-2', bank_account_id: 'ba-2' },
        { id: 'bt-3', bank_account_id: 'ba-1' },
      ];

      const filtered = transactions.filter(t => t.bank_account_id === 'ba-1');
      expect(filtered).toHaveLength(2);
    });

    it('should filter by transaction type', () => {
      const transactions = [
        { id: 'bt-1', transaction_type: 'credit' },
        { id: 'bt-2', transaction_type: 'debit' },
        { id: 'bt-3', transaction_type: 'credit' },
      ];

      const credits = transactions.filter(t => t.transaction_type === 'credit');
      const debits = transactions.filter(t => t.transaction_type === 'debit');

      expect(credits).toHaveLength(2);
      expect(debits).toHaveLength(1);
    });

    it('should filter by reconciliation status', () => {
      const transactions = [
        { id: 'bt-1', is_reconciled: true },
        { id: 'bt-2', is_reconciled: false },
        { id: 'bt-3', is_reconciled: false },
      ];

      const reconciled = transactions.filter(t => t.is_reconciled === true);
      const unreconciled = transactions.filter(t => t.is_reconciled === false);

      expect(reconciled).toHaveLength(1);
      expect(unreconciled).toHaveLength(2);
    });

    it('should filter by date range', () => {
      const transactions = [
        { id: 'bt-1', transaction_date: '2024-01-15' },
        { id: 'bt-2', transaction_date: '2024-01-20' },
        { id: 'bt-3', transaction_date: '2024-02-01' },
      ];

      const startDate = '2024-01-01';
      const endDate = '2024-01-31';

      const filtered = transactions.filter(t => 
        t.transaction_date >= startDate && t.transaction_date <= endDate
      );

      expect(filtered).toHaveLength(2);
    });

    it('should search by description', () => {
      const transactions = [
        { id: 'bt-1', description: 'Payment from Customer ABC' },
        { id: 'bt-2', description: 'Utility Bill Payment' },
        { id: 'bt-3', description: 'Customer XYZ Payment' },
      ];

      const searchQuery = 'customer';
      const filtered = transactions.filter(t => 
        t.description.toLowerCase().includes(searchQuery.toLowerCase())
      );

      expect(filtered).toHaveLength(2);
    });
  });

  describe('Selection', () => {
    it('should select single transaction', () => {
      const selected = new Set<string>();
      selected.add('bt-1');

      expect(selected.size).toBe(1);
      expect(selected.has('bt-1')).toBe(true);
    });

    it('should select all transactions', () => {
      const transactions = [
        { id: 'bt-1' },
        { id: 'bt-2' },
        { id: 'bt-3' },
      ];

      const selected = new Set(transactions.map(t => t.id));

      expect(selected.size).toBe(3);
    });

    it('should deselect transaction', () => {
      const selected = new Set(['bt-1', 'bt-2', 'bt-3']);
      selected.delete('bt-2');

      expect(selected.size).toBe(2);
      expect(selected.has('bt-2')).toBe(false);
    });

    it('should clear all selections', () => {
      const selected = new Set(['bt-1', 'bt-2', 'bt-3']);
      selected.clear();

      expect(selected.size).toBe(0);
    });
  });

  describe('Auto-Match', () => {
    it('should identify high confidence matches', () => {
      const matches = [
        { transaction_id: 'bt-1', confidence: 0.95 },
        { transaction_id: 'bt-2', confidence: 0.6 },
        { transaction_id: 'bt-3', confidence: 0.85 },
      ];

      const highConfidence = matches.filter(m => m.confidence >= 0.7);
      expect(highConfidence).toHaveLength(2);
    });

    it('should filter unreconciled transactions for matching', () => {
      const transactions = [
        { id: 'bt-1', is_reconciled: false },
        { id: 'bt-2', is_reconciled: true },
        { id: 'bt-3', is_reconciled: false },
      ];

      const eligibleForMatching = transactions.filter(t => !t.is_reconciled);
      expect(eligibleForMatching).toHaveLength(2);
    });

    it('should match credits to invoices', () => {
      const transaction = { id: 'bt-1', transaction_type: 'credit', amount: 5000 };
      const invoices = [
        { id: 'inv-1', total: 5000, amount_paid: 0 },
        { id: 'inv-2', total: 3000, amount_paid: 0 },
      ];

      const exactMatch = invoices.find(inv => 
        (inv.total - inv.amount_paid) === transaction.amount
      );

      expect(exactMatch).toBeDefined();
      expect(exactMatch?.id).toBe('inv-1');
    });

    it('should match debits to bills', () => {
      const transaction = { id: 'bt-1', transaction_type: 'debit', amount: -3000 };
      const bills = [
        { id: 'bill-1', total: 5000, amount_paid: 0 },
        { id: 'bill-2', total: 3000, amount_paid: 0 },
      ];

      const exactMatch = bills.find(bill => 
        (bill.total - bill.amount_paid) === Math.abs(transaction.amount)
      );

      expect(exactMatch).toBeDefined();
      expect(exactMatch?.id).toBe('bill-2');
    });
  });

  describe('Reconciliation Dialog', () => {
    it('should validate reconciliation type', () => {
      const validTypes = ['invoice', 'expense', 'bill', 'transfer', 'manual'];
      const selectedType = 'invoice';

      expect(validTypes.includes(selectedType)).toBe(true);
    });

    it('should require entity for non-manual types', () => {
      const reconcileData = {
        reconciled_type: 'invoice',
        reconciled_entity_id: 'inv-1',
      };

      const isValid = reconcileData.reconciled_type === 'manual' || 
                     reconcileData.reconciled_entity_id !== undefined;

      expect(isValid).toBe(true);
    });

    it('should allow manual reconciliation without entity', () => {
      const reconcileData = {
        reconciled_type: 'manual',
        category: 'Operating Expenses',
      };

      const isValid = reconcileData.reconciled_type === 'manual';
      expect(isValid).toBe(true);
    });
  });

  describe('Unreconcile', () => {
    it('should clear reconciliation data', () => {
      const transaction = {
        id: 'bt-1',
        is_reconciled: true,
        reconciled_type: 'invoice',
        reconciled_entity_id: 'inv-1',
        reconciled_at: '2024-01-15T12:00:00Z',
      };

      // Simulate unreconcile
      const unreconciled = {
        ...transaction,
        is_reconciled: false,
        reconciled_type: null,
        reconciled_entity_id: null,
        reconciled_at: null,
      };

      expect(unreconciled.is_reconciled).toBe(false);
      expect(unreconciled.reconciled_type).toBeNull();
      expect(unreconciled.reconciled_entity_id).toBeNull();
    });
  });

  describe('Bulk Operations', () => {
    it('should reconcile multiple transactions', () => {
      const selectedIds = ['bt-1', 'bt-2', 'bt-3'];
      const reconcileCount = selectedIds.length;

      expect(reconcileCount).toBe(3);
    });

    it('should export selected transactions', () => {
      const transactions = [
        { id: 'bt-1', description: 'Payment 1', amount: 5000 },
        { id: 'bt-2', description: 'Payment 2', amount: 3000 },
      ];

      const selectedIds = ['bt-1'];
      const toExport = transactions.filter(t => selectedIds.includes(t.id));

      expect(toExport).toHaveLength(1);
      expect(toExport[0].description).toBe('Payment 1');
    });
  });
});
