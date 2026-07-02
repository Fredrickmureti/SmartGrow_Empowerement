import { CartItem, CartCustomer, CartState } from '@/hooks/pos/usePOSCart';

// Mock Product
export interface MockProduct {
  id: string;
  name: string;
  sku?: string;
  price: number;
  cost_price?: number;
  tax_rate?: number;
  stock_quantity?: number;
  is_active?: boolean;
}

export const createMockProduct = (overrides: Partial<MockProduct> = {}): MockProduct => ({
  id: 'prod-1',
  name: 'Test Product',
  sku: 'SKU-001',
  price: 1000,
  cost_price: 600,
  tax_rate: 0, // Default to zero — tests should explicitly set tax rate when needed
  stock_quantity: 100,
  is_active: true,
  ...overrides,
});

// Mock Cart Item
export const createMockCartItem = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'item-1',
  product_id: 'prod-1',
  name: 'Test Product',
  sku: 'SKU-001',
  quantity: 1,
  unit_price: 1000,
  discount_type: undefined,
  discount_value: 0,
  tax_rate: 16,
  tax_amount: 160,
  line_total: 1160,
  cost_price: 600,
  ...overrides,
});

// Mock Customer
export const createMockCustomer = (overrides: Partial<CartCustomer> = {}): CartCustomer => ({
  id: 'cust-1',
  name: 'Test Customer',
  email: 'customer@example.com',
  phone: '+254700000000',
  ...overrides,
});

// Mock Shift
export interface MockShift {
  id: string;
  organization_id: string;
  register_id: string;
  user_id: string;
  shift_number: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number | null;
  cash_difference: number | null;
  status: 'open' | 'closed' | 'reconciled';
  notes: string | null;
  register?: {
    id: string;
    register_name: string;
    register_code: string;
  };
}

export const createMockShift = (overrides: Partial<MockShift> = {}): MockShift => ({
  id: 'shift-1',
  organization_id: 'test-org-id',
  register_id: 'reg-1',
  user_id: 'test-user-id',
  shift_number: 'SHIFT-001',
  opened_at: new Date().toISOString(),
  closed_at: null,
  opening_cash: 5000,
  expected_cash: 5000,
  actual_cash: null,
  cash_difference: null,
  status: 'open',
  notes: null,
  register: {
    id: 'reg-1',
    register_name: 'Register 1',
    register_code: 'REG-001',
  },
  ...overrides,
});

// Mock Register
export interface MockRegister {
  id: string;
  organization_id: string;
  register_name: string;
  register_code: string;
  is_active: boolean;
  last_active_at: string | null;
}

export const createMockRegister = (overrides: Partial<MockRegister> = {}): MockRegister => ({
  id: 'reg-1',
  organization_id: 'test-org-id',
  register_name: 'Register 1',
  register_code: 'REG-001',
  is_active: true,
  last_active_at: null,
  ...overrides,
});

// Mock Transaction
export interface MockTransaction {
  id: string;
  organization_id: string;
  shift_id: string;
  transaction_number: string;
  transaction_type: 'sale' | 'return' | 'void';
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  payment_status: 'pending' | 'paid' | 'partial' | 'refunded';
  customer_id: string | null;
  created_at: string;
}

export const createMockTransaction = (overrides: Partial<MockTransaction> = {}): MockTransaction => ({
  id: 'txn-1',
  organization_id: 'test-org-id',
  shift_id: 'shift-1',
  transaction_number: 'TXN-001',
  transaction_type: 'sale',
  subtotal: 1000,
  discount_amount: 0,
  tax_amount: 160,
  total: 1160,
  payment_status: 'paid',
  customer_id: null,
  created_at: new Date().toISOString(),
  ...overrides,
});

// Pre-created mock data arrays
export const mockProducts: MockProduct[] = [
  createMockProduct(),
  createMockProduct({
    id: 'prod-2',
    name: 'Premium Product',
    sku: 'SKU-002',
    price: 5000,
    cost_price: 3000,
    tax_rate: 16,
  }),
  createMockProduct({
    id: 'prod-3',
    name: 'Budget Product',
    sku: 'SKU-003',
    price: 500,
    cost_price: 300,
    tax_rate: 0, // Tax exempt
  }),
];

export const mockShifts: MockShift[] = [
  createMockShift(),
  createMockShift({
    id: 'shift-2',
    shift_number: 'SHIFT-002',
    status: 'closed',
    closed_at: new Date().toISOString(),
    actual_cash: 15000,
    expected_cash: 15000,
    cash_difference: 0,
  }),
];

export const mockRegisters: MockRegister[] = [
  createMockRegister(),
  createMockRegister({
    id: 'reg-2',
    register_name: 'Register 2',
    register_code: 'REG-002',
  }),
];

// Cart test scenarios
export const cartTestCases = {
  singleItem: {
    product: createMockProduct(),
    quantity: 1,
    expectedSubtotal: 1000,
    expectedTax: 160,
    expectedTotal: 1160,
  },
  multipleItems: {
    products: [
      { product: createMockProduct(), quantity: 2 },
      { product: createMockProduct({ id: 'prod-2', price: 500, tax_rate: 16 }), quantity: 3 },
    ],
    expectedSubtotal: 3500,
    expectedTax: 560,
    expectedTotal: 4060,
  },
  withPercentDiscount: {
    product: createMockProduct(),
    quantity: 2,
    discountType: 'percent' as const,
    discountValue: 10,
    expectedSubtotal: 1800, // 2000 - 10%
    expectedTax: 288,
    expectedTotal: 2088,
  },
  withFixedDiscount: {
    product: createMockProduct(),
    quantity: 2,
    discountType: 'fixed' as const,
    discountValue: 200,
    expectedSubtotal: 1800, // 2000 - 200
    expectedTax: 288,
    expectedTotal: 2088,
  },
};
