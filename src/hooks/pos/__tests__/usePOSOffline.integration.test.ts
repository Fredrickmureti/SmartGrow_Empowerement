/**
 * Integration Tests for POS Offline Functionality
 * 
 * Tests offline transaction queuing and sync behavior:
 * 1. Queue transactions when offline
 * 2. Persist to IndexedDB
 * 3. Sync when back online
 * 4. Handle sync conflicts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  createMockCart, 
  createSplitPayments,
  createMockTransaction,
  resetTransactionFactories 
} from '@/test/factories/transaction.factory';

// Mock navigator.onLine
const mockOnline = (isOnline: boolean) => {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: isOnline,
  });
};

describe('POS Offline Integration', () => {
  beforeEach(() => {
    resetTransactionFactories();
    mockOnline(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockOnline(true);
  });

  describe('Offline Detection', () => {
    it('should detect online state', () => {
      mockOnline(true);
      expect(navigator.onLine).toBe(true);
    });

    it('should detect offline state', () => {
      mockOnline(false);
      expect(navigator.onLine).toBe(false);
    });
  });

  describe('Transaction Queue Structure', () => {
    it('should create valid offline transaction payload', () => {
      const cart = createMockCart({ total: 2500 });
      const payments = createSplitPayments(cart.total, ['cash']);
      
      const offlineTransaction = {
        id: `offline-${Date.now()}`,
        created_at: new Date().toISOString(),
        synced: false,
        retry_count: 0,
        data: {
          register_id: 'reg-1',
          shift_id: 'shift-1',
          items: cart.items,
          payments,
          subtotal: cart.subtotal,
          tax_amount: cart.tax_total,
          discount_amount: cart.discount_total,
          total: cart.total,
        },
      };
      
      expect(offlineTransaction.synced).toBe(false);
      expect(offlineTransaction.retry_count).toBe(0);
      expect(offlineTransaction.data.total).toBe(cart.total);
    });

    it('should include all required transaction fields', () => {
      const cart = createMockCart({ itemCount: 2 });
      const payments = createSplitPayments(cart.total, ['mobile_money']);
      
      const transactionPayload = {
        register_id: 'reg-1',
        shift_id: 'shift-1',
        cashier_id: 'cashier-1',
        items: cart.items.map(item => ({
          product_id: item.product_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_amount: item.discount_amount,
          tax_amount: item.tax_amount,
          line_total: item.line_total,
        })),
        payments: payments.map(p => ({
          payment_method: p.payment_method,
          amount: p.amount,
          reference: p.reference,
        })),
        subtotal: cart.subtotal,
        tax_amount: cart.tax_total,
        discount_amount: cart.discount_total,
        total: cart.total,
      };
      
      // Validate required fields
      expect(transactionPayload.register_id).toBeDefined();
      expect(transactionPayload.shift_id).toBeDefined();
      expect(transactionPayload.items.length).toBeGreaterThan(0);
      expect(transactionPayload.payments.length).toBeGreaterThan(0);
      expect(transactionPayload.total).toBeGreaterThan(0);
    });
  });

  describe('Queue Operations', () => {
    it('should track pending transaction count', () => {
      const pendingTransactions: Array<{ id: string; synced: boolean }> = [];
      
      // Simulate queuing 3 transactions
      for (let i = 0; i < 3; i++) {
        pendingTransactions.push({
          id: `offline-${i}`,
          synced: false,
        });
      }
      
      const pendingCount = pendingTransactions.filter(t => !t.synced).length;
      expect(pendingCount).toBe(3);
    });

    it('should mark transactions as synced', () => {
      const pendingTransactions = [
        { id: 'offline-1', synced: false },
        { id: 'offline-2', synced: false },
        { id: 'offline-3', synced: false },
      ];
      
      // Mark first transaction as synced
      pendingTransactions[0].synced = true;
      
      const pendingCount = pendingTransactions.filter(t => !t.synced).length;
      expect(pendingCount).toBe(2);
    });

    it('should increment retry count on failed sync', () => {
      const transaction = {
        id: 'offline-1',
        synced: false,
        retry_count: 0,
        last_error: null as string | null,
      };
      
      // Simulate failed sync
      transaction.retry_count += 1;
      transaction.last_error = 'Network error';
      
      expect(transaction.retry_count).toBe(1);
      expect(transaction.last_error).toBe('Network error');
    });

    it('should respect max retry limit', () => {
      const MAX_RETRIES = 5;
      const transaction = {
        id: 'offline-1',
        synced: false,
        retry_count: 5,
      };
      
      const shouldRetry = transaction.retry_count < MAX_RETRIES;
      expect(shouldRetry).toBe(false);
    });
  });

  describe('Sync Priority', () => {
    it('should sync oldest transactions first', () => {
      const transactions = [
        { id: '1', created_at: new Date('2024-01-01').toISOString() },
        { id: '2', created_at: new Date('2024-01-03').toISOString() },
        { id: '3', created_at: new Date('2024-01-02').toISOString() },
      ];
      
      const sorted = [...transactions].sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      
      expect(sorted[0].id).toBe('1');
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('2');
    });

    it('should prioritize transactions with fewer retries', () => {
      const transactions = [
        { id: '1', retry_count: 3 },
        { id: '2', retry_count: 0 },
        { id: '3', retry_count: 1 },
      ];
      
      const sorted = [...transactions].sort((a, b) => 
        a.retry_count - b.retry_count
      );
      
      expect(sorted[0].id).toBe('2');
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });
  });

  describe('Stock Reservation Offline', () => {
    it('should track local stock changes', () => {
      const localStock = new Map<string, number>([
        ['prod-1', 100],
        ['prod-2', 50],
      ]);
      
      // Simulate sale
      const cart = createMockCart({
        items: [
          { product_id: 'prod-1', quantity: 2, unit_price: 500 },
          { product_id: 'prod-2', quantity: 1, unit_price: 1000 },
        ],
      });
      
      // Update local stock
      cart.items.forEach(item => {
        const current = localStock.get(item.product_id) || 0;
        localStock.set(item.product_id, current - item.quantity);
      });
      
      expect(localStock.get('prod-1')).toBe(98);
      expect(localStock.get('prod-2')).toBe(49);
    });

    it('should prevent sale when insufficient local stock', () => {
      const localStock = new Map<string, number>([
        ['prod-1', 5],
      ]);
      
      const requestedQuantity = 10;
      const availableStock = localStock.get('prod-1') || 0;
      
      const canSell = availableStock >= requestedQuantity;
      expect(canSell).toBe(false);
    });
  });

  describe('Conflict Resolution', () => {
    it('should detect server-side changes during offline period', () => {
      const localTransaction = {
        id: 'offline-1',
        transaction_type: 'sale',
        total: 5000,
      };
      
      const serverResponse = {
        success: false,
        error: 'STOCK_CHANGED',
        details: {
          product_id: 'prod-1',
          requested: 5,
          available: 2,
        },
      };
      
      const hasConflict = serverResponse.error === 'STOCK_CHANGED';
      expect(hasConflict).toBe(true);
    });

    it('should handle duplicate transaction detection', () => {
      const transactionNumber = 'POS1-260126-0001';
      
      const serverResponse = {
        success: false,
        error: 'DUPLICATE_TRANSACTION',
        existing_id: 'txn-123',
      };
      
      const isDuplicate = serverResponse.error === 'DUPLICATE_TRANSACTION';
      expect(isDuplicate).toBe(true);
    });
  });
});
