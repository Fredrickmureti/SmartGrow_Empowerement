/**
 * Test Factories for POS Transactions
 * 
 * Provides utility functions to create mock data for testing
 * POS transaction flows including carts, payments, and complete transactions.
 */

// ============ TYPES ============

export interface MockCartItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  tax_amount: number;
  line_total: number;
}

export interface MockCart {
  items: MockCartItem[];
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
}

export interface MockPayment {
  payment_method: 'cash' | 'card' | 'mobile_money' | 'mpesa' | 'bank_transfer';
  amount: number;
  reference?: string;
  mpesa_receipt_number?: string;
}

export interface MockTransaction {
  id: string;
  transaction_number: string;
  register_id: string;
  shift_id: string;
  cashier_id: string;
  customer_id: string | null;
  customer_name: string | null;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  status: 'completed' | 'voided' | 'refunded' | 'pending';
  created_at: string;
  items: MockCartItem[];
  payments: MockPayment[];
}

// ============ CART FACTORIES ============

export function createMockCartItem(overrides: Partial<MockCartItem> = {}): MockCartItem {
  const quantity = overrides.quantity ?? 1;
  const unitPrice = overrides.unit_price ?? 1000;
  const discountAmount = overrides.discount_amount ?? 0;
  const taxRate = 0.16; // Default for tests — production uses DB-configured rates
  const lineSubtotal = quantity * unitPrice - discountAmount;
  const taxAmount = overrides.tax_amount ?? Math.round(lineSubtotal * taxRate);
  
  return {
    product_id: `prod-${Math.random().toString(36).slice(2, 9)}`,
    name: `Test Product ${Math.floor(Math.random() * 100)}`,
    quantity,
    unit_price: unitPrice,
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    line_total: lineSubtotal + taxAmount,
    ...overrides,
  };
}

export function createMockCart(options: {
  itemCount?: number;
  total?: number;
  items?: Partial<MockCartItem>[];
} = {}): MockCart {
  const { itemCount = 2, total, items: itemOverrides } = options;
  
  let cartItems: MockCartItem[];
  
  if (itemOverrides) {
    cartItems = itemOverrides.map(override => createMockCartItem(override));
  } else if (total) {
    // Distribute total across items
    const perItemTotal = Math.floor(total / itemCount);
    cartItems = Array.from({ length: itemCount }, (_, i) => 
      createMockCartItem({
        unit_price: i === itemCount - 1 
          ? total - (perItemTotal * (itemCount - 1)) // Last item gets remainder
          : perItemTotal,
        quantity: 1,
        tax_amount: 0,
        discount_amount: 0,
      })
    );
  } else {
    cartItems = Array.from({ length: itemCount }, () => createMockCartItem());
  }
  
  const subtotal = cartItems.reduce((sum, item) => 
    sum + (item.quantity * item.unit_price), 0);
  const discountTotal = cartItems.reduce((sum, item) => 
    sum + item.discount_amount, 0);
  const taxTotal = cartItems.reduce((sum, item) => 
    sum + item.tax_amount, 0);
  
  return {
    items: cartItems,
    subtotal,
    discount_total: discountTotal,
    tax_total: taxTotal,
    total: subtotal - discountTotal + taxTotal,
  };
}

// ============ PAYMENT FACTORIES ============

export function createMockPayment(overrides: Partial<MockPayment> = {}): MockPayment {
  return {
    payment_method: 'cash',
    amount: 1000,
    ...overrides,
  };
}

export function createSplitPayments(
  total: number,
  methods: MockPayment['payment_method'][] = ['cash', 'mobile_money']
): MockPayment[] {
  const splitAmount = Math.floor(total / methods.length);
  
  return methods.map((method, index) => ({
    payment_method: method,
    amount: index === methods.length - 1 
      ? total - (splitAmount * (methods.length - 1)) // Last payment gets remainder
      : splitAmount,
    reference: method === 'mpesa' ? 'QXH7890ABC' : undefined,
    mpesa_receipt_number: method === 'mpesa' ? 'QXH7890ABC' : undefined,
  }));
}

// ============ TRANSACTION FACTORIES ============

let transactionIdCounter = 0;

export function createMockTransaction(overrides: Partial<MockTransaction> = {}): MockTransaction {
  transactionIdCounter++;
  const cart = createMockCart({ itemCount: 2 });
  
  return {
    id: `txn-${transactionIdCounter}`,
    transaction_number: `POS1-260126-${String(transactionIdCounter).padStart(4, '0')}`,
    register_id: 'register-1',
    shift_id: 'shift-1',
    cashier_id: 'cashier-1',
    customer_id: null,
    customer_name: null,
    subtotal: cart.subtotal,
    discount_amount: cart.discount_total,
    tax_amount: cart.tax_total,
    total: cart.total,
    status: 'completed',
    created_at: new Date().toISOString(),
    items: cart.items,
    payments: [createMockPayment({ amount: cart.total })],
    ...overrides,
  };
}

export function createVoidedTransaction(
  originalTransaction: MockTransaction,
  reason: string = 'Customer request'
): MockTransaction {
  return {
    ...originalTransaction,
    id: `${originalTransaction.id}-void`,
    status: 'voided',
  };
}

export function createRefundTransaction(
  originalTransaction: MockTransaction,
  refundAmount?: number
): MockTransaction {
  const amount = refundAmount ?? originalTransaction.total;
  
  return {
    ...originalTransaction,
    id: `${originalTransaction.id}-refund`,
    transaction_number: `${originalTransaction.transaction_number}-R`,
    total: -amount,
    status: 'refunded',
    payments: [createMockPayment({ amount: -amount })],
  };
}

// ============ SHIFT FACTORIES ============

export interface MockShift {
  id: string;
  shift_number: string;
  register_id: string;
  cashier_id: string;
  status: 'open' | 'closed';
  opening_cash: number;
  closing_cash: number | null;
  expected_cash: number | null;
  cash_difference: number | null;
  opened_at: string;
  closed_at: string | null;
  transactions_count: number;
  total_sales: number;
}

let shiftIdCounter = 0;

export function createMockShift(overrides: Partial<MockShift> = {}): MockShift {
  shiftIdCounter++;
  
  return {
    id: `shift-${shiftIdCounter}`,
    shift_number: `SH-REG1-260126-${String(shiftIdCounter).padStart(2, '0')}`,
    register_id: 'register-1',
    cashier_id: 'cashier-1',
    status: 'open',
    opening_cash: 5000,
    closing_cash: null,
    expected_cash: null,
    cash_difference: null,
    opened_at: new Date().toISOString(),
    closed_at: null,
    transactions_count: 0,
    total_sales: 0,
    ...overrides,
  };
}

export function createClosedShift(openShift: MockShift, totals: {
  totalSales: number;
  closingCash: number;
  transactionsCount: number;
}): MockShift {
  const expectedCash = openShift.opening_cash + totals.closingCash;
  
  return {
    ...openShift,
    status: 'closed',
    closing_cash: totals.closingCash,
    expected_cash: expectedCash,
    cash_difference: totals.closingCash - expectedCash,
    closed_at: new Date().toISOString(),
    transactions_count: totals.transactionsCount,
    total_sales: totals.totalSales,
  };
}

// ============ RESET UTILITIES ============

export function resetTransactionFactories(): void {
  transactionIdCounter = 0;
  shiftIdCounter = 0;
}
