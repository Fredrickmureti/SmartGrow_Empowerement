/**
 * Centralized query key factory for consistent cache management
 * All query keys should be defined here to ensure real-time updates
 * propagate to all related caches
 */

export const queryKeys = {
  // ========== Products ==========
  products: {
    all: (orgId: string) => ['products', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['products', orgId, businessId] as const,
    pos: (orgId: string, businessId?: string | null) => 
      ['pos-products', orgId, businessId] as const,
    posCache: (orgId: string) => 
      ['pos-products-cache', orgId] as const,
    paginated: (orgId: string, businessId?: string | null, filters?: Record<string, unknown>) => 
      ['products-paginated', orgId, businessId, filters] as const,
    detail: (orgId: string, productId: string) => 
      ['product', orgId, productId] as const,
  },
  
  // ========== Notifications ==========
  notifications: {
    all: (orgId: string) => ['notifications', orgId] as const,
    unread: (orgId: string) => ['notifications-unread', orgId] as const,
    count: (orgId: string) => ['notifications-count', orgId] as const,
  },
  
  // ========== Contacts ==========
  contacts: {
    all: (orgId: string) => ['contacts', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['contacts', orgId, businessId] as const,
    detail: (orgId: string, contactId: string) =>
      ['contact', orgId, contactId] as const,
  },
  
  // ========== Invoices ==========
  invoices: {
    all: (orgId: string) => ['invoices', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['invoices', orgId, businessId] as const,
    detail: (orgId: string, invoiceId: string) =>
      ['invoice', orgId, invoiceId] as const,
  },
  
  // ========== Bills ==========
  bills: {
    all: (orgId: string) => ['bills', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['bills', orgId, businessId] as const,
    detail: (orgId: string, billId: string) =>
      ['bill', orgId, billId] as const,
  },
  
  // ========== Payments ==========
  payments: {
    all: (orgId: string) => ['payments', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['payments', orgId, businessId] as const,
    forInvoice: (invoiceId: string) =>
      ['payments-for-invoice', invoiceId] as const,
  },
  
  // ========== Expenses ==========
  expenses: {
    all: (orgId: string) => ['expenses', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['expenses', orgId, businessId] as const,
    categories: (orgId: string) =>
      ['expense-categories', orgId] as const,
  },
  
  // ========== Sales Orders ==========
  salesOrders: {
    all: (orgId: string) => ['sales-orders', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['sales-orders', orgId, businessId] as const,
    detail: (orgId: string, orderId: string) =>
      ['sales-order', orgId, orderId] as const,
  },
  
  // ========== Purchase Orders ==========
  purchaseOrders: {
    all: (orgId: string) => ['purchase-orders', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['purchase-orders', orgId, businessId] as const,
    detail: (orgId: string, orderId: string) =>
      ['purchase-order', orgId, orderId] as const,
  },
  
  // ========== Purchase Returns ==========
  purchaseReturns: {
    all: (orgId: string) => ['purchase-returns', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['purchase-returns', orgId, businessId] as const,
  },
  
  // ========== CRM Leads ==========
  leads: {
    all: (orgId: string) => ['crm-leads', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['crm-leads', orgId, businessId] as const,
    byStage: (orgId: string, stageId?: string) =>
      ['crm-leads', orgId, 'stage', stageId] as const,
  },
  
  // ========== Employees ==========
  employees: {
    all: (orgId: string) => ['employees', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['employees', orgId, businessId] as const,
    detail: (orgId: string, employeeId: string) =>
      ['employee', orgId, employeeId] as const,
  },
  
  // ========== Leave Requests ==========
  leaveRequests: {
    all: (orgId: string) => ['leave-requests', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['leave-requests', orgId, businessId] as const,
    pending: (orgId: string) =>
      ['leave-requests-pending', orgId] as const,
  },
  
  // ========== Projects ==========
  projects: {
    all: (orgId: string) => ['projects', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['projects', orgId, businessId] as const,
    detail: (orgId: string, projectId: string) =>
      ['project', orgId, projectId] as const,
    stages: (projectId: string) =>
      ['project-stages', projectId] as const,
    milestones: (projectId: string) =>
      ['project-milestones', projectId] as const,
  },
  
  // ========== POS Transactions/Sales ==========
  sales: {
    all: (orgId: string) => ['sales', orgId] as const,
    pos: (orgId: string, businessId?: string | null) => 
      ['pos-sales', orgId, businessId] as const,
    posTransactions: (orgId: string, filters?: Record<string, unknown>) =>
      ['pos-transactions', orgId, filters] as const,
  },
  
  // ========== Stock Movements ==========
  stockMovements: {
    all: (orgId: string) => ['stock-movements', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['stock-movements', orgId, businessId] as const,
  },
  
  // ========== Journal Entries ==========
  journalEntries: {
    all: (orgId: string) => ['journal-entries', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['journal-entries', orgId, businessId] as const,
  },
  
  // ========== Bank Transactions ==========
  bankTransactions: {
    all: (orgId: string) => ['bank-transactions', orgId] as const,
    list: (orgId: string, businessId?: string | null, filters?: Record<string, unknown>) => 
      ['bank-transactions', orgId, businessId, filters] as const,
  },
  
  // ========== Estimates ==========
  estimates: {
    all: (orgId: string) => ['estimates', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['estimates', orgId, businessId] as const,
  },
  
  // ========== Delivery Notes ==========
  deliveryNotes: {
    all: (orgId: string) => ['delivery-notes', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['delivery-notes', orgId, businessId] as const,
  },

  // ========== Proforma Invoices ==========
  proformaInvoices: {
    all: (orgId: string) => ['proforma-invoices', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['proforma-invoices', orgId, businessId] as const,
  },

  // ========== Recurring Invoices ==========
  recurringInvoices: {
    all: (orgId: string) => ['recurring-invoices', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['recurring-invoices', orgId, businessId] as const,
  },

  // ========== Sales Returns ==========
  salesReturns: {
    all: (orgId: string) => ['sales-returns', orgId] as const,
    list: (orgId: string, businessId?: string | null) => 
      ['sales-returns', orgId, businessId] as const,
  },
  
  // ========== Financial Reports ==========
  reports: {
    financial: (orgId: string) => ['financial-report', orgId] as const,
    generalLedger: (orgId: string) => ['general-ledger', orgId] as const,
    trialBalance: (orgId: string) => ['trial-balance', orgId] as const,
    aging: (orgId: string) => ['aging-report', orgId] as const,
    cashFlow: (orgId: string) => ['cash-flow-report', orgId] as const,
    budgetVsActual: (orgId: string) => ['budget-vs-actual', orgId] as const,
  },

  // ========== Accounts ==========
  accounts: {
    all: (orgId: string) => ['accounts', orgId] as const,
    list: (orgId: string, businessId?: string | null) =>
      ['accounts', orgId, businessId] as const,
  },

  // ========== Account Balances (RPC-derived) ==========
  accountBalances: {
    rpc: (orgId: string, businessId?: string | null) =>
      ['account-balances-rpc', orgId, businessId] as const,
  },

  // ========== Fiscal Periods ==========
  fiscalPeriods: {
    all: (orgId: string, businessId?: string | null) =>
      ['fiscal-periods', orgId, businessId] as const,
    detail: (orgId: string, businessId?: string | null, periodId?: string, startDate?: string, endDate?: string) =>
      ['fiscal-period-detail', orgId, businessId, periodId, startDate, endDate] as const,
    single: (periodId?: string) =>
      ['fiscal-period', periodId] as const,
    adjacent: (orgId: string, businessId?: string | null, periodId?: string) =>
      ['fiscal-period-adjacent', orgId, businessId, periodId] as const,
  },

  // ========== Fixed Assets ==========
  fixedAssets: {
    all: (orgId: string) => ['fixed-assets', orgId] as const,
    list: (orgId: string, businessId?: string | null) =>
      ['fixed-assets', orgId, businessId] as const,
  },

  // ========== Budgets ==========
  budgets: {
    all: (orgId: string) => ['budgets', orgId] as const,
    list: (orgId: string, businessId?: string | null) =>
      ['budgets', orgId, businessId] as const,
  },

  // ========== Credit Notes ==========
  creditNotes: {
    all: (orgId: string) => ['credit-notes', orgId] as const,
    list: (orgId: string, businessId?: string | null) =>
      ['credit-notes', orgId, businessId] as const,
  },

  // ========== Bank Accounts ==========
  bankAccounts: {
    all: (orgId: string) => ['bank-accounts', orgId] as const,
    list: (orgId: string, businessId?: string | null) =>
      ['bank-accounts', orgId, businessId] as const,
  },

  // ========== Default Account Settings ==========
  defaultAccounts: {
    all: (orgId: string, businessId?: string | null) =>
      ['default-accounts', orgId, businessId] as const,
  },

  // ========== Dashboard ==========
  dashboard: {
    /**
     * Dashboard cache keys are scope-aware. `scopeKind` distinguishes
     * branch_only / all_branches / business_only views and `branchId`
     * (or "ALL") is included so switching branches forces a refetch.
     * See `useDashboardScope` for the source of these values.
     */
    stats: (
      orgId: string,
      businessId?: string | null,
      scopeKind: string = 'branch_only',
      branchId: string | null = null,
    ) =>
      ['dashboard-stats', orgId, businessId, scopeKind, branchId ?? 'ALL'] as const,
    executive: (
      orgId: string,
      businessId?: string | null,
      scopeKind: string = 'branch_only',
      branchId: string | null = null,
    ) =>
      ['executive-stats', orgId, businessId, scopeKind, branchId ?? 'ALL'] as const,
    activity: (
      orgId: string,
      businessId?: string | null,
      scopeKind: string = 'branch_only',
      branchId: string | null = null,
    ) =>
      ['activity-feed', orgId, businessId, scopeKind, branchId ?? 'ALL'] as const,
    analytics: (
      orgId: string,
      businessId?: string | null,
      scopeKind: string = 'branch_only',
      branchId: string | null = null,
    ) =>
      ['dashboard-analytics', orgId, businessId, scopeKind, branchId ?? 'ALL'] as const,
  },

  // ========== GL Totals ==========
  glTotals: {
    range: (orgId: string, businessId?: string | null, dateFrom?: string, dateTo?: string) =>
      ['gl-totals', orgId, businessId, dateFrom, dateTo] as const,
  },

  // ========== GL Intelligence ==========
  glIntelligence: {
    all: (orgId: string, businessId?: string | null) =>
      ['gl-intelligence', orgId, businessId] as const,
  },
};

/**
 * Helper to get all product-related query keys for a given org
 * Used to invalidate all product caches when a product changes
 */
export function getAllProductQueryKeys(orgId: string, businessId?: string | null) {
  return [
    queryKeys.products.all(orgId),
    queryKeys.products.list(orgId, businessId),
    queryKeys.products.pos(orgId, businessId),
    queryKeys.products.posCache(orgId),
    // Include paginated with undefined filters to match partial keys
    ['products-paginated', orgId],
  ];
}

/**
 * Helper to invalidate all related caches for an entity type
 */
export function getEntityQueryKeys(
  entityType: keyof typeof queryKeys,
  orgId: string,
  businessId?: string | null
): (readonly unknown[])[] {
  const entityKeys = queryKeys[entityType];
  if (!entityKeys) return [];
  
  const keys: (readonly unknown[])[] = [];
  
  if ('all' in entityKeys) {
    keys.push((entityKeys.all as (orgId: string) => readonly unknown[])(orgId));
  }
  if ('list' in entityKeys) {
    keys.push((entityKeys.list as (orgId: string, businessId?: string | null) => readonly unknown[])(orgId, businessId));
  }
  
  return keys;
}
