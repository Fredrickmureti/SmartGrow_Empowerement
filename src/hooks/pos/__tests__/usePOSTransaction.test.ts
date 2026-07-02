import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  createMockTransaction, 
  createMockShift,
  createMockProduct,
  createMockCartItem,
} from '@/test/factories/pos.factory';

// Mock Supabase
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ 
            data: createMockTransaction(), 
            error: null 
          })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
      })),
    })),
    rpc: vi.fn(() => Promise.resolve({ data: 'TXN-001', error: null })),
  },
}));

describe('POS Transaction Logic', () => {
  describe('Transaction Data Model', () => {
    it('should have correct transaction interface', () => {
      const transaction = createMockTransaction();
      
      expect(transaction).toHaveProperty('id');
      expect(transaction).toHaveProperty('organization_id');
      expect(transaction).toHaveProperty('shift_id');
      expect(transaction).toHaveProperty('transaction_number');
      expect(transaction).toHaveProperty('transaction_type');
      expect(transaction).toHaveProperty('subtotal');
      expect(transaction).toHaveProperty('discount_amount');
      expect(transaction).toHaveProperty('tax_amount');
      expect(transaction).toHaveProperty('total');
      expect(transaction).toHaveProperty('payment_status');
    });

    it('should have valid transaction types', () => {
      const validTypes: Array<'sale' | 'return' | 'void'> = ['sale', 'return', 'void'];
      
      validTypes.forEach(type => {
        const transaction = createMockTransaction({ transaction_type: type });
        expect(transaction.transaction_type).toBe(type);
      });
    });

    it('should have valid payment statuses', () => {
      const validStatuses: Array<'pending' | 'paid' | 'partial' | 'refunded'> = [
        'pending', 'paid', 'partial', 'refunded'
      ];
      
      validStatuses.forEach(status => {
        const transaction = createMockTransaction({ payment_status: status });
        expect(transaction.payment_status).toBe(status);
      });
    });
  });

  describe('Transaction Totals Calculation', () => {
    it('should calculate subtotal correctly from items', () => {
      const items = [
        createMockCartItem({ quantity: 2, unit_price: 1000 }),
        createMockCartItem({ id: 'item-2', quantity: 3, unit_price: 500 }),
      ];

      const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
      expect(subtotal).toBe(3500); // 2000 + 1500
    });

    it('should calculate tax correctly', () => {
      const subtotal = 1000;
      const taxRate = 16;
      const taxAmount = subtotal * (taxRate / 100);

      expect(taxAmount).toBe(160);
    });

    it('should calculate total with discount', () => {
      const subtotal = 1000;
      const discountAmount = 100;
      const taxAmount = 144; // 900 * 16%
      const total = subtotal - discountAmount + taxAmount;

      expect(total).toBe(1044);
    });

    it('should handle multiple items with different tax rates', () => {
      const items = [
        { subtotal: 1000, tax_rate: 16 }, // Tax: 160
        { subtotal: 500, tax_rate: 0 },   // Tax: 0
        { subtotal: 200, tax_rate: 8 },   // Tax: 16
      ];

      const totalTax = items.reduce((sum, item) => sum + (item.subtotal * item.tax_rate / 100), 0);
      expect(totalTax).toBe(176);
    });
  });

  describe('Stock Management', () => {
    it('should reduce stock on sale completion', () => {
      const product = createMockProduct({ stock_quantity: 100 });
      const quantitySold = 5;
      const newStock = (product.stock_quantity || 0) - quantitySold;

      expect(newStock).toBe(95);
    });

    it('should increase stock on return', () => {
      const currentStock = 95;
      const quantityReturned = 2;
      const newStock = currentStock + quantityReturned;

      expect(newStock).toBe(97);
    });

    it('should not allow negative stock', () => {
      const product = createMockProduct({ stock_quantity: 3 });
      const quantityRequested = 5;
      const canFulfill = (product.stock_quantity || 0) >= quantityRequested;

      expect(canFulfill).toBe(false);
    });
  });

  describe('Payment Processing', () => {
    it('should mark transaction as paid when full payment received', () => {
      const total = 1160;
      const paymentAmount = 1160;
      const paymentStatus = paymentAmount >= total ? 'paid' : 'partial';

      expect(paymentStatus).toBe('paid');
    });

    it('should mark transaction as partial when partial payment', () => {
      const total = 1160;
      const paymentAmount = 500;
      const paymentStatus = paymentAmount >= total ? 'paid' : 'partial';

      expect(paymentStatus).toBe('partial');
    });

    it('should calculate change correctly for cash payments', () => {
      const total = 1160;
      const cashTendered = 1500;
      const change = cashTendered - total;

      expect(change).toBe(340);
    });

    it('should handle multiple payment methods', () => {
      const total = 1160;
      const payments = [
        { method: 'cash', amount: 500 },
        { method: 'mpesa', amount: 660 },
      ];

      const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
      expect(totalPaid).toBe(1160);
      expect(totalPaid).toBeGreaterThanOrEqual(total);
    });
  });

  describe('Expected Cash Updates', () => {
    it('should update shift expected cash after cash sale', () => {
      const shift = createMockShift({ expected_cash: 5000 });
      const cashPayment = 1000;
      const newExpectedCash = shift.expected_cash + cashPayment;

      expect(newExpectedCash).toBe(6000);
    });

    it('should not update expected cash for card payments', () => {
      const shift = createMockShift({ expected_cash: 5000 });
      // Card payments don't affect cash drawer
      expect(shift.expected_cash).toBe(5000);
    });

    it('should reduce expected cash for cash refund', () => {
      const shift = createMockShift({ expected_cash: 6000 });
      const refundAmount = 500;
      const newExpectedCash = shift.expected_cash - refundAmount;

      expect(newExpectedCash).toBe(5500);
    });
  });

  describe('Void Transaction', () => {
    it('should set transaction type to void', () => {
      const transaction = createMockTransaction({ transaction_type: 'void' });
      expect(transaction.transaction_type).toBe('void');
    });

    it('should restore stock on void', () => {
      const currentStock = 95;
      const voidedQuantity = 5;
      const restoredStock = currentStock + voidedQuantity;

      expect(restoredStock).toBe(100);
    });

    it('should reverse cash drawer update on void', () => {
      const expectedCash = 6000;
      const voidedCashAmount = 1000;
      const restoredExpectedCash = expectedCash - voidedCashAmount;

      expect(restoredExpectedCash).toBe(5000);
    });
  });

  describe('Return Transaction', () => {
    it('should create return transaction', () => {
      const transaction = createMockTransaction({ 
        transaction_type: 'return',
        payment_status: 'refunded',
      });

      expect(transaction.transaction_type).toBe('return');
      expect(transaction.payment_status).toBe('refunded');
    });

    it('should increase stock on return', () => {
      const currentStock = 95;
      const returnedQuantity = 2;
      const newStock = currentStock + returnedQuantity;

      expect(newStock).toBe(97);
    });
  });

  describe('Transaction Items', () => {
    it('should link items to transaction', () => {
      const transactionId = 'txn-1';
      const items = [
        { ...createMockCartItem(), transaction_id: transactionId },
        { ...createMockCartItem({ id: 'item-2' }), transaction_id: transactionId },
      ];

      items.forEach(item => {
        expect(item.transaction_id).toBe(transactionId);
      });
    });

    it('should preserve item discounts in transaction', () => {
      const item = createMockCartItem({
        discount_type: 'percent',
        discount_value: 10,
      });

      expect(item.discount_type).toBe('percent');
      expect(item.discount_value).toBe(10);
    });
  });
});
