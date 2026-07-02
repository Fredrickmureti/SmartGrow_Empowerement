/**
 * React Hook for SQLite Database Access
 * Provides reactive database operations for POS components
 */

import { useState, useEffect, useCallback } from 'react';
import { useOrganization } from '@/hooks/useOrganization';
import { toast } from 'sonner';
import {
  isElectron,
  isDatabaseReady,
  initializeDatabase,
  executeQuery,
  executeTransaction,
  getDatabaseStats,
  getPendingSyncCount,
  getCachedProducts,
  getCachedCustomers,
  searchProducts,
  getProductByBarcode,
  getOpenShift,
  getTodayTransactions,
  getHeldTransactions,
  saveHeldTransaction,
  deleteHeldTransaction,
  setAuditContext,
  type DatabaseStats,
  type QueryResult,
} from '@/services/offline/SQLiteBridge';

export interface UseSQLiteDatabaseReturn {
  // State
  isAvailable: boolean;
  isInitialized: boolean;
  isLoading: boolean;
  stats: DatabaseStats | null;
  pendingSyncCount: number;
  
  // Initialization
  initialize: (password: string, userId: string) => Promise<boolean>;
  
  // Generic queries
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  transaction: (queries: Array<{ sql: string; params?: unknown[] }>) => Promise<boolean>;
  
  // Product operations
  products: any[];
  refreshProducts: () => Promise<void>;
  searchProducts: (query: string) => Promise<any[]>;
  getProductByBarcode: (barcode: string) => Promise<any | null>;
  
  // Customer operations
  customers: any[];
  refreshCustomers: () => Promise<void>;
  
  // Shift operations
  currentShift: any | null;
  refreshShift: (registerId: string) => Promise<void>;
  
  // Transaction operations
  todayTransactions: any[];
  refreshTransactions: () => Promise<void>;
  
  // Held transactions
  heldTransactions: any[];
  holdTransaction: (data: any) => Promise<boolean>;
  recallHeldTransaction: (id: string) => Promise<any | null>;
  
  // Utilities
  refreshStats: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export function useSQLiteDatabase(): UseSQLiteDatabaseReturn {
  const { currentOrg } = useOrganization();
  const organizationId = currentOrg?.id;
  
  // State
  const [isAvailable] = useState(() => isElectron());
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  
  // Cached data
  const [products, setProducts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [currentShift, setCurrentShift] = useState<any | null>(null);
  const [todayTransactions, setTodayTransactions] = useState<any[]>([]);
  const [heldTransactions, setHeldTransactionsState] = useState<any[]>([]);

  // Check initialization status on mount
  useEffect(() => {
    if (isAvailable) {
      isDatabaseReady().then(ready => {
        setIsInitialized(ready);
      });
    }
  }, [isAvailable]);

  // Initialize database
  const initialize = useCallback(async (password: string, userId: string): Promise<boolean> => {
    if (!isAvailable) {
      console.warn('SQLite not available - not in Electron');
      return false;
    }

    setIsLoading(true);
    try {
      const result = await initializeDatabase(password, userId);
      
      if (result.success) {
        setIsInitialized(true);
        
        // Set audit context if organization available
        if (organizationId && userId) {
          await setAuditContext(organizationId, userId, '');
        }
        
        toast.success('Offline database initialized');
        return true;
      } else {
        toast.error(result.error || 'Failed to initialize database');
        return false;
      }
    } catch (error) {
      console.error('Database initialization error:', error);
      toast.error('Database initialization failed');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isAvailable, organizationId]);

  // Generic query
  const query = useCallback(async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (!isInitialized) {
      console.warn('Database not initialized');
      return [];
    }
    
    const result = await executeQuery<T>(sql, params);
    return result.success ? result.data || [] : [];
  }, [isInitialized]);

  // Generic transaction
  const transaction = useCallback(async (queries: Array<{ sql: string; params?: unknown[] }>): Promise<boolean> => {
    if (!isInitialized) {
      console.warn('Database not initialized');
      return false;
    }
    
    const result = await executeTransaction(queries);
    return result.success;
  }, [isInitialized]);

  // Refresh products
  const refreshProducts = useCallback(async () => {
    if (!isInitialized || !organizationId) return;
    
    const data = await getCachedProducts(organizationId);
    setProducts(data);
  }, [isInitialized, organizationId]);

  // Search products
  const searchProductsHandler = useCallback(async (searchQuery: string): Promise<any[]> => {
    if (!isInitialized || !organizationId) return [];
    return searchProducts(organizationId, searchQuery);
  }, [isInitialized, organizationId]);

  // Get product by barcode
  const getProductByBarcodeHandler = useCallback(async (barcode: string): Promise<any | null> => {
    if (!isInitialized || !organizationId) return null;
    return getProductByBarcode(organizationId, barcode);
  }, [isInitialized, organizationId]);

  // Refresh customers
  const refreshCustomers = useCallback(async () => {
    if (!isInitialized || !organizationId) return;
    
    const data = await getCachedCustomers(organizationId);
    setCustomers(data);
  }, [isInitialized, organizationId]);

  // Refresh shift
  const refreshShift = useCallback(async (registerId: string) => {
    if (!isInitialized || !organizationId) return;
    
    const shift = await getOpenShift(organizationId, registerId);
    setCurrentShift(shift);
  }, [isInitialized, organizationId]);

  // Refresh transactions
  const refreshTransactions = useCallback(async () => {
    if (!isInitialized || !organizationId) return;
    
    const data = await getTodayTransactions(organizationId, currentShift?.id);
    setTodayTransactions(data);
  }, [isInitialized, organizationId, currentShift?.id]);

  // Refresh held transactions
  const refreshHeldTransactions = useCallback(async () => {
    if (!isInitialized || !organizationId) return;
    
    const data = await getHeldTransactions(organizationId);
    setHeldTransactionsState(data);
  }, [isInitialized, organizationId]);

  // Hold transaction
  const holdTransaction = useCallback(async (data: any): Promise<boolean> => {
    if (!isInitialized || !organizationId) return false;
    
    const success = await saveHeldTransaction({
      ...data,
      organizationId,
    });
    
    if (success) {
      await refreshHeldTransactions();
      toast.success('Transaction held');
    }
    
    return success;
  }, [isInitialized, organizationId, refreshHeldTransactions]);

  // Recall held transaction
  const recallHeldTransaction = useCallback(async (id: string): Promise<any | null> => {
    if (!isInitialized) return null;
    
    const held = heldTransactions.find(t => t.id === id);
    if (!held) return null;
    
    await deleteHeldTransaction(id);
    await refreshHeldTransactions();
    
    // Parse items JSON
    return {
      ...held,
      items: typeof held.items === 'string' ? JSON.parse(held.items) : held.items,
    };
  }, [isInitialized, heldTransactions, refreshHeldTransactions]);

  // Refresh stats
  const refreshStats = useCallback(async () => {
    if (!isInitialized) return;
    
    const [statsResult, pendingCount] = await Promise.all([
      getDatabaseStats(),
      getPendingSyncCount(),
    ]);
    
    if (statsResult.success && statsResult.data) {
      setStats(statsResult.data);
    }
    setPendingSyncCount(pendingCount);
  }, [isInitialized]);

  // Refresh all data
  const refreshAll = useCallback(async () => {
    if (!isInitialized || !organizationId) return;
    
    setIsLoading(true);
    try {
      await Promise.all([
        refreshProducts(),
        refreshCustomers(),
        refreshTransactions(),
        refreshHeldTransactions(),
        refreshStats(),
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [isInitialized, organizationId, refreshProducts, refreshCustomers, refreshTransactions, refreshHeldTransactions, refreshStats]);

  // Auto-refresh on initialization
  useEffect(() => {
    if (isInitialized && organizationId) {
      refreshAll();
    }
  }, [isInitialized, organizationId]);

  return {
    isAvailable,
    isInitialized,
    isLoading,
    stats,
    pendingSyncCount,
    initialize,
    query,
    transaction,
    products,
    refreshProducts,
    searchProducts: searchProductsHandler,
    getProductByBarcode: getProductByBarcodeHandler,
    customers,
    refreshCustomers,
    currentShift,
    refreshShift,
    todayTransactions,
    refreshTransactions,
    heldTransactions,
    holdTransaction,
    recallHeldTransaction,
    refreshStats,
    refreshAll,
  };
}
