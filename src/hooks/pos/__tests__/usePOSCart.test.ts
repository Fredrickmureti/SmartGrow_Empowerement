import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePOSCart } from '@/hooks/pos/usePOSCart';
import { createMockProduct, cartTestCases } from '@/test/factories/pos.factory';

describe('usePOSCart', () => {
  describe('Initial State', () => {
    it('should initialize with empty cart', () => {
      const { result } = renderHook(() => usePOSCart());
      
      expect(result.current.items).toEqual([]);
      expect(result.current.itemCount).toBe(0);
      expect(result.current.totalQuantity).toBe(0);
      expect(result.current.subtotal).toBe(0);
      expect(result.current.tax_amount).toBe(0);
      expect(result.current.total).toBe(0);
      expect(result.current.customer).toBeNull();
    });
  });

  describe('addItem', () => {
    it('should add a new item to the cart', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 1);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].name).toBe(product.name);
      expect(result.current.items[0].quantity).toBe(1);
      expect(result.current.items[0].unit_price).toBe(product.price);
    });

    it('should increase quantity when adding existing product', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 1);
        result.current.addItem(product, 2);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].quantity).toBe(3);
    });

    it('should add multiple different products', () => {
      const { result } = renderHook(() => usePOSCart());
      const product1 = createMockProduct({ id: 'prod-1' });
      const product2 = createMockProduct({ id: 'prod-2', name: 'Product 2' });

      act(() => {
        result.current.addItem(product1, 1);
        result.current.addItem(product2, 2);
      });

      expect(result.current.items).toHaveLength(2);
      expect(result.current.totalQuantity).toBe(3);
    });

    it('should calculate correct tax amount', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct({ price: 1000, tax_rate: 16 });

      act(() => {
        result.current.addItem(product, 1);
      });

      // Tax = 1000 * 0.16 = 160
      expect(result.current.items[0].tax_amount).toBe(160);
      expect(result.current.items[0].line_total).toBe(1160);
    });

    it('should handle products with zero tax', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct({ price: 1000, tax_rate: 0 });

      act(() => {
        result.current.addItem(product, 1);
      });

      expect(result.current.items[0].tax_amount).toBe(0);
      expect(result.current.items[0].line_total).toBe(1000);
    });
  });

  describe('updateQuantity', () => {
    it('should update item quantity', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 1);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.updateQuantity(itemId, 5);
      });

      expect(result.current.items[0].quantity).toBe(5);
    });

    it('should remove item when quantity is set to 0', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 1);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.updateQuantity(itemId, 0);
      });

      expect(result.current.items).toHaveLength(0);
    });

    it('should recalculate totals when quantity changes', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct({ price: 1000, tax_rate: 16 });

      act(() => {
        result.current.addItem(product, 1);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.updateQuantity(itemId, 3);
      });

      // 3 * 1000 = 3000, tax = 3000 * 0.16 = 480
      expect(result.current.items[0].line_total).toBe(3480);
    });
  });

  describe('removeItem', () => {
    it('should remove item from cart', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 1);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.removeItem(itemId);
      });

      expect(result.current.items).toHaveLength(0);
    });

    it('should not affect other items when removing one', () => {
      const { result } = renderHook(() => usePOSCart());
      const product1 = createMockProduct({ id: 'prod-1' });
      const product2 = createMockProduct({ id: 'prod-2', name: 'Product 2' });

      act(() => {
        result.current.addItem(product1, 1);
        result.current.addItem(product2, 1);
      });

      const itemId1 = result.current.items[0].id;

      act(() => {
        result.current.removeItem(itemId1);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].name).toBe('Product 2');
    });
  });

  describe('applyItemDiscount', () => {
    it('should apply percentage discount to item', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct({ price: 1000, tax_rate: 16 });

      act(() => {
        result.current.addItem(product, 2);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.applyItemDiscount(itemId, 'percent', 10);
      });

      // 2 * 1000 = 2000, 10% discount = 200, after discount = 1800
      // Tax = 1800 * 0.16 = 288
      expect(result.current.items[0].discount_type).toBe('percent');
      expect(result.current.items[0].discount_value).toBe(10);
      expect(result.current.items[0].line_total).toBe(2088);
    });

    it('should apply fixed discount to item', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct({ price: 1000, tax_rate: 16 });

      act(() => {
        result.current.addItem(product, 2);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.applyItemDiscount(itemId, 'fixed', 200);
      });

      // 2 * 1000 = 2000, fixed discount = 200, after discount = 1800
      // Tax = 1800 * 0.16 = 288
      expect(result.current.items[0].discount_type).toBe('fixed');
      expect(result.current.items[0].discount_value).toBe(200);
      expect(result.current.items[0].line_total).toBe(2088);
    });
  });

  describe('clearCart', () => {
    it('should clear all items from cart', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 5);
        result.current.setNotes('Test notes');
      });

      act(() => {
        result.current.clearCart();
      });

      expect(result.current.items).toHaveLength(0);
      expect(result.current.notes).toBe('');
      expect(result.current.customer).toBeNull();
    });
  });

  describe('Cart Totals Calculation', () => {
    it('should calculate subtotal correctly', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 1000, tax_rate: 0 }), 2);
        result.current.addItem(createMockProduct({ id: 'p2', price: 500, tax_rate: 0 }), 3);
      });

      expect(result.current.subtotal).toBe(3500); // 2000 + 1500
    });

    it('should calculate total tax correctly', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 1000, tax_rate: 16 }), 1);
        result.current.addItem(createMockProduct({ id: 'p2', price: 500, tax_rate: 16 }), 2);
      });

      // (1000 + 1000) * 0.16 = 320
      expect(result.current.tax_amount).toBe(320);
    });

    it('should calculate grand total correctly', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 1000, tax_rate: 16 }), 1);
      });

      expect(result.current.total).toBe(1160); // 1000 + 160 tax
    });

    it('calculates net payable as subtotal minus discounts plus tax', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 100, tax_rate: 16 }), 1);
        result.current.addItem(createMockProduct({ id: 'p2', price: 100, tax_rate: 0 }), 1);
        result.current.setCartDiscount({ type: 'fixed', value: 50 });
      });

      expect(result.current.subtotal).toBe(200);
      expect(result.current.discount_amount).toBe(50);
      expect(result.current.tax_amount).toBe(12);
      expect(result.current.total).toBe(162);
    });

    it('clamps cart-level discounts so net payable cannot go negative', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 100, tax_rate: 16 }), 1);
        result.current.setCartDiscount({ type: 'fixed', value: 200 });
      });

      expect(result.current.subtotal).toBe(100);
      expect(result.current.discount_amount).toBe(100);
      expect(result.current.tax_amount).toBe(0);
      expect(result.current.total).toBe(0);
    });

    it('clamps line discounts before calculating tax', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.addItem(createMockProduct({ id: 'p1', price: 100, tax_rate: 16 }), 1);
      });

      const itemId = result.current.items[0].id;

      act(() => {
        result.current.applyItemDiscount(itemId, 'fixed', 150);
      });

      expect(result.current.subtotal).toBe(0);
      expect(result.current.tax_amount).toBe(0);
      expect(result.current.total).toBe(0);
    });
  });

  describe('Customer Management', () => {
    it('should set customer', () => {
      const { result } = renderHook(() => usePOSCart());

      act(() => {
        result.current.setCustomer({
          id: 'cust-1',
          name: 'John Doe',
          email: 'john@example.com',
          phone: '+254700000000',
        });
      });

      expect(result.current.customer).not.toBeNull();
      expect(result.current.customer?.name).toBe('John Doe');
    });
  });

  describe('Cart State (save/restore)', () => {
    it('should provide complete cart state', () => {
      const { result } = renderHook(() => usePOSCart());
      const product = createMockProduct();

      act(() => {
        result.current.addItem(product, 2);
        result.current.setNotes('Test order');
      });

      const state = result.current.cartState;
      
      expect(state.items).toHaveLength(1);
      expect(state.notes).toBe('Test order');
      expect(state.subtotal).toBeGreaterThan(0);
      expect(state.total).toBeGreaterThan(0);
    });

    it('should restore cart from saved state', () => {
      const { result } = renderHook(() => usePOSCart());
      
      const savedState = {
        items: [{
          id: 'item-1',
          product_id: 'prod-1',
          name: 'Saved Product',
          quantity: 3,
          unit_price: 500,
          discount_type: undefined,
          discount_value: 0,
          tax_rate: 16,
          tax_amount: 240,
          line_total: 1740,
        }],
        customer: { id: 'cust-1', name: 'Saved Customer' },
        subtotal: 1500,
        discount_amount: 0,
        tax_amount: 240,
        total: 1740,
        notes: 'Restored order',
      };

      act(() => {
        result.current.restoreCart(savedState);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].name).toBe('Saved Product');
      expect(result.current.customer?.name).toBe('Saved Customer');
      expect(result.current.notes).toBe('Restored order');
    });
  });
});
