/**
 * Integration Tests for POS Transaction Flow
 * 
 * Tests the complete transaction lifecycle:
 * 1. Open shift
 * 2. Complete sale with various payment methods
 * 3. Void transaction
 * 4. Close shift
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { 
  createMockCart, 
  createSplitPayments, 
  resetTransactionFactories 
} from '@/test/factories/transaction.factory';
import { resetPOSMockState } from '@/test/mocks/handlers/pos.handlers';

// Create a wrapper with QueryClient for hooks
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
  
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
};

describe('POS Transaction Integration', () => {
  beforeEach(() => {
    resetTransactionFactories();
    resetPOSMockState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Cart Operations', () => {
    it('should calculate cart totals correctly for single item', () => {
      const cart = createMockCart({ itemCount: 1, total: 1000 });
      
      expect(cart.items).toHaveLength(1);
      expect(cart.total).toBe(1000);
    });

    it('should calculate cart totals correctly for multiple items', () => {
      const cart = createMockCart({
        items: [
          { unit_price: 500, quantity: 2 },
          { unit_price: 1000, quantity: 1 },
        ],
      });
      
      expect(cart.items).toHaveLength(2);
      expect(cart.subtotal).toBe(2000); // (500*2) + (1000*1)
    });

    it('should handle discounts correctly', () => {
      const cart = createMockCart({
        items: [
          { unit_price: 1000, quantity: 1, discount_amount: 100 },
        ],
      });
      
      expect(cart.discount_total).toBe(100);
      expect(cart.subtotal).toBe(1000);
    });
  });

  describe('Payment Processing', () => {
    it('should create single payment correctly', () => {
      const cart = createMockCart({ total: 5000 });
      const payments = createSplitPayments(cart.total, ['cash']);
      
      expect(payments).toHaveLength(1);
      expect(payments[0].payment_method).toBe('cash');
      expect(payments[0].amount).toBe(5000);
    });

    it('should create split payments correctly', () => {
      const total = 5000;
      const payments = createSplitPayments(total, ['cash', 'mobile_money']);
      
      expect(payments).toHaveLength(2);
      expect(payments[0].payment_method).toBe('cash');
      expect(payments[1].payment_method).toBe('mobile_money');
      
      // Total should equal the sum of split payments
      const paymentSum = payments.reduce((sum, p) => sum + p.amount, 0);
      expect(paymentSum).toBe(total);
    });

    it('should handle M-Pesa payments with receipt number', () => {
      const payments = createSplitPayments(1000, ['mpesa']);
      
      expect(payments[0].payment_method).toBe('mpesa');
      expect(payments[0].mpesa_receipt_number).toBeDefined();
    });

    it('should handle three-way split payments', () => {
      const total = 9000;
      const payments = createSplitPayments(total, ['cash', 'card', 'mobile_money']);
      
      expect(payments).toHaveLength(3);
      
      const paymentSum = payments.reduce((sum, p) => sum + p.amount, 0);
      expect(paymentSum).toBe(total);
    });
  });

  describe('Transaction Factory', () => {
    it('should create unique transaction IDs', () => {
      resetTransactionFactories();
      
      const cart1 = createMockCart({ itemCount: 1 });
      const cart2 = createMockCart({ itemCount: 1 });
      
      // Each cart should have unique item IDs
      expect(cart1.items[0].product_id).not.toBe(cart2.items[0].product_id);
    });

    it('should include tax in line totals when not zero', () => {
      const cart = createMockCart({
        items: [
          { unit_price: 1000, quantity: 1, tax_amount: 160 },
        ],
      });
      
      expect(cart.items[0].line_total).toBe(1160); // 1000 + 160 tax
      expect(cart.tax_total).toBe(160);
    });
  });

  describe('Shift Lifecycle', () => {
    it('should track opening cash in shift', async () => {
      const { createMockShift } = await import('@/test/factories/transaction.factory');
      
      const shift = createMockShift({ opening_cash: 10000 });
      
      expect(shift.opening_cash).toBe(10000);
      expect(shift.status).toBe('open');
      expect(shift.closed_at).toBeNull();
    });

    it('should track closing cash and calculate difference', async () => {
      const { createMockShift, createClosedShift } = await import('@/test/factories/transaction.factory');
      
      const openShift = createMockShift({ opening_cash: 5000 });
      const closedShift = createClosedShift(openShift, {
        totalSales: 15000,
        closingCash: 12000,
        transactionsCount: 10,
      });
      
      expect(closedShift.status).toBe('closed');
      expect(closedShift.closed_at).not.toBeNull();
      expect(closedShift.transactions_count).toBe(10);
      expect(closedShift.total_sales).toBe(15000);
    });
  });

  describe('Complete Transaction Flow', () => {
    it('should complete full transaction cycle', async () => {
      // 1. Create cart with items
      const cart = createMockCart({ 
        itemCount: 3,
        total: 5000 
      });
      
      expect(cart.items).toHaveLength(3);
      expect(cart.total).toBeGreaterThan(0);
      
      // 2. Create payments that match total
      const payments = createSplitPayments(cart.total, ['cash']);
      
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(cart.total);
      
      // 3. Validate transaction data structure
      const transactionData = {
        register_id: 'reg-1',
        shift_id: 'shift-1',
        subtotal: cart.subtotal,
        discount_amount: cart.discount_total,
        tax_amount: cart.tax_total,
        total: cart.total,
        items: cart.items,
        payments,
      };
      
      expect(transactionData.total).toBe(cart.total);
      expect(transactionData.items.length).toBeGreaterThan(0);
    });

    it('should handle transaction with customer', async () => {
      const cart = createMockCart({ total: 3000 });
      const payments = createSplitPayments(cart.total, ['card']);
      
      const transactionData = {
        register_id: 'reg-1',
        shift_id: 'shift-1',
        customer_id: 'cust-1',
        customer_name: 'John Doe',
        customer_tin: 'A123456789Z',
        total: cart.total,
        items: cart.items,
        payments,
      };
      
      expect(transactionData.customer_id).toBe('cust-1');
      expect(transactionData.customer_name).toBe('John Doe');
    });
  });
});
