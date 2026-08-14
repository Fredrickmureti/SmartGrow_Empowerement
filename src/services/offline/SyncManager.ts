/**
 * Sync Manager for Offline POS Operations
 * Manages connection status and synchronization between local and server data
 */

import { offlineStorage, STORES } from "./OfflineStorageService";
import { transactionQueue } from "./TransactionQueue";
import { supabase } from "@/integrations/supabase/client";
import { connectivityManager } from "@/services/resilience/ConnectivityManager";
import type { POSProduct } from "@/hooks/pos/usePOSProducts";

type ConnectionStatus = "online" | "offline" | "syncing";
type SyncStatusCallback = (status: ConnectionStatus) => void;
type QueueCountCallback = (count: number) => void;

interface SyncResult {
  success: boolean;
  transactionsSynced: number;
  transactionsFailed: number;
  productsCached: number;
  customersCached: number;
  error?: string;
}

class SyncManager {
  private isOnline: boolean = navigator.onLine;
  private statusCallbacks: Set<SyncStatusCallback> = new Set();
  private queueCountCallbacks: Set<QueueCountCallback> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private productCacheInterval: ReturnType<typeof setInterval> | null = null;
  private connectivityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private stabilityChecks: boolean[] = [];
  private readonly STABILITY_CHECK_COUNT = 2;

  constructor() {
    this.setupNetworkListeners();
  }

  /**
   * Setup network status listeners
   */
  private setupNetworkListeners(): void {
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  private handleOnline = async (): Promise<void> => {
    console.log("Network connection detected - verifying real connectivity...");
    // Don't immediately set online - verify with real connectivity check
    this.startConnectivityChecks();
  };

  private handleOffline = (): void => {
    console.log("Network connection lost");
    this.isOnline = false;
    this.stabilityChecks = [];
    this.stopConnectivityChecks();
    this.notifyStatusChange("offline");
  };

  /**
   * Start periodic connectivity checks to verify real connectivity
   */
  private startConnectivityChecks(): void {
    this.stopConnectivityChecks();
    
    // Immediately check once
    this.performConnectivityCheck();
    
    // Then check periodically until stable
    this.connectivityCheckInterval = setInterval(() => {
      this.performConnectivityCheck();
    }, 2000);
  }

  private stopConnectivityChecks(): void {
    if (this.connectivityCheckInterval) {
      clearInterval(this.connectivityCheckInterval);
      this.connectivityCheckInterval = null;
    }
  }

  /**
   * Perform actual connectivity check to Supabase
   */
  private async performConnectivityCheck(): Promise<void> {
    const isConnected = await this.checkRealConnectivity();
    this.stabilityChecks.push(isConnected);
    
    // Keep only last N checks
    if (this.stabilityChecks.length > this.STABILITY_CHECK_COUNT) {
      this.stabilityChecks.shift();
    }
    
    // Determine if connection is now stable
    const wasOnline = this.isOnline;
    const isNowStable = 
      this.stabilityChecks.length >= this.STABILITY_CHECK_COUNT &&
      this.stabilityChecks.every(check => check);
    
    if (isNowStable && !wasOnline) {
      console.log("Connection verified stable - going online");
      this.isOnline = true;
      this.stopConnectivityChecks();
      this.notifyStatusChange("syncing");
      
      try {
        await this.syncPendingTransactions();
        this.notifyStatusChange("online");
      } catch (error) {
        console.error("Sync failed after reconnection:", error);
        this.notifyStatusChange("online");
      }
    } else if (!isConnected && this.stabilityChecks.every(c => !c)) {
      // All recent checks failed - go offline
      if (wasOnline) {
        console.log("Real connectivity lost - going offline");
        this.isOnline = false;
        this.stopConnectivityChecks();
        this.notifyStatusChange("offline");
      }
    }
  }

  /**
   * Check real connectivity by making a HEAD request to Supabase
   */
  private async checkRealConnectivity(): Promise<boolean> {
    if (!navigator.onLine) return false;
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`,
        {
          method: "HEAD",
          signal: controller.signal,
        }
      );
      
      clearTimeout(timeout);
      return response.ok || response.status === 401; // 401 is fine, means we reached the server
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to connection status changes
   */
  onStatusChange(callback: SyncStatusCallback): () => void {
    this.statusCallbacks.add(callback);
    // Immediately notify with current status
    callback(this.getStatus());
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Subscribe to queue count changes
   */
  onQueueCountChange(callback: QueueCountCallback): () => void {
    this.queueCountCallbacks.add(callback);
    // Immediately notify with current count
    this.getQueueCount().then(callback);
    return () => this.queueCountCallbacks.delete(callback);
  }

  private notifyStatusChange(status: ConnectionStatus): void {
    this.statusCallbacks.forEach((cb) => cb(status));
  }

  private async notifyQueueCountChange(): Promise<void> {
    const count = await this.getQueueCount();
    this.queueCountCallbacks.forEach((cb) => cb(count));
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.isOnline ? "online" : "offline";
  }

  /**
   * Check if currently online. Delegates to the single source of
   * truth (`ConnectivityManager`) which combines `navigator.onLine`,
   * Electron OS-level net status, and probe results. The legacy
   * internal `this.isOnline` flag is kept only as a fallback signal
   * for code paths that haven't yet adopted `connectivityManager`.
   */
  checkOnline(): boolean {
    const cm = connectivityManager.getStatus();
    if (cm === "offline") return false;
    // Treat `degraded` as still-online for queueing decisions — POS
    // callers want to attempt the call; supabaseSafe will normalize
    // any transport failure back to offline.
    return cm === "online" || cm === "degraded" || this.isOnline;
  }

  /**
   * Force a connectivity check and return result
   */
  async forceConnectivityCheck(): Promise<boolean> {
    const isConnected = await this.checkRealConnectivity();
    
    if (isConnected && !this.isOnline) {
      this.isOnline = true;
      this.notifyStatusChange("online");
    } else if (!isConnected && this.isOnline) {
      this.isOnline = false;
      this.notifyStatusChange("offline");
    }
    
    return isConnected;
  }

  /**
   * Get pending transaction queue count
   */
  async getQueueCount(): Promise<number> {
    return transactionQueue.getQueueCount();
  }

  /**
   * Initialize the sync manager
   */
  async initialize(organizationId: string): Promise<void> {
    await offlineStorage.init();
    
    // Initial product cache
    await this.cacheProducts(organizationId);
    await this.cacheCustomers(organizationId);

    // Setup periodic sync (every 5 minutes when online)
    this.startPeriodicSync(organizationId);
    
    // Sync any pending transactions
    if (this.isOnline) {
      await this.syncPendingTransactions();
    }
  }

  /**
   * Start periodic sync
   */
  private startPeriodicSync(organizationId: string): void {
    // Sync transactions every minute
    this.syncInterval = setInterval(async () => {
      if (this.isOnline) {
        await this.syncPendingTransactions();
      }
    }, 60000);

    // Refresh product cache every 5 minutes
    this.productCacheInterval = setInterval(async () => {
      if (this.isOnline) {
        await this.cacheProducts(organizationId);
      }
    }, 300000);
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.productCacheInterval) {
      clearInterval(this.productCacheInterval);
      this.productCacheInterval = null;
    }
  }

  /**
   * Cache products to IndexedDB
   */
  async cacheProducts(organizationId: string): Promise<number> {
    if (!this.isOnline) return 0;

    try {
      // SCOPE-EXEMPT: offline cache for POS terminal — caches all products in workspace
      const { data, error } = await supabase
        .from("products")
        .select(`
          *,
          tax_rate_ref:tax_rates(id, name, rate, etims_tax_code)
        `)
        .eq("organization_id", organizationId)
        .eq("status", "active");

      if (error) throw error;

      const products: POSProduct[] = data.map((p) => {
        const taxRef = p.tax_rate_ref as { id: string; name: string; rate: number; etims_tax_code: string | null } | null;
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          description: p.description,
          selling_price: p.unit_price || 0,
          cost_price: p.cost_price,
          tax_rate: taxRef?.rate ?? p.tax_rate,
          stock_quantity: p.stock_quantity,
          category: p.type,
          image_url: p.image_url,
          base_uom_id: (p as { base_uom_id?: string | null }).base_uom_id ?? null,
          is_active: p.is_active,
          track_inventory: p.track_inventory,
          reorder_level: p.reorder_level,
          // Tax metadata for compliance
          tax_rate_id: taxRef?.id ?? p.tax_rate_id,
          tax_rate_name: taxRef?.name ?? null,
          etims_tax_code: taxRef?.etims_tax_code ?? null,
        };
      });

      await offlineStorage.clear(STORES.PRODUCTS);
      await offlineStorage.putBulk(STORES.PRODUCTS, products);
      await offlineStorage.updateSyncMeta("products", new Date().toISOString());

      console.log(`Cached ${products.length} products for offline use`);
      return products.length;
    } catch (error) {
      console.error("Failed to cache products:", error);
      return 0;
    }
  }

  /**
   * Get cached products
   */
  async getCachedProducts(): Promise<POSProduct[]> {
    return offlineStorage.getAll<POSProduct>(STORES.PRODUCTS);
  }

  /**
   * Update a single product in the IndexedDB cache (for real-time sync)
   */
  async updateSingleProductInCache(product: Partial<POSProduct> & { id: string }): Promise<void> {
    try {
      const cached = await this.getCachedProducts();
      const existingIndex = cached.findIndex(p => p.id === product.id);
      
      if (existingIndex >= 0) {
        // Update existing product
        cached[existingIndex] = { ...cached[existingIndex], ...product };
      } else {
        // Add new product (if it's a full product object)
        if (product.name && product.selling_price !== undefined) {
          cached.push(product as POSProduct);
        }
      }
      
      await offlineStorage.clear(STORES.PRODUCTS);
      await offlineStorage.putBulk(STORES.PRODUCTS, cached);
      console.log(`[SyncManager] Updated product ${product.id} in IndexedDB cache`);
    } catch (error) {
      console.error('[SyncManager] Failed to update single product in cache:', error);
    }
  }

  /**
   * Remove a product from the IndexedDB cache (for real-time sync)
   */
  async removeProductFromCache(productId: string): Promise<void> {
    try {
      const cached = await this.getCachedProducts();
      const filtered = cached.filter(p => p.id !== productId);
      
      await offlineStorage.clear(STORES.PRODUCTS);
      await offlineStorage.putBulk(STORES.PRODUCTS, filtered);
      console.log(`[SyncManager] Removed product ${productId} from IndexedDB cache`);
    } catch (error) {
      console.error('[SyncManager] Failed to remove product from cache:', error);
    }
  }

  /**
   * Cache customers to IndexedDB
   */
  async cacheCustomers(organizationId: string): Promise<number> {
    if (!this.isOnline) return 0;

    try {
      // SCOPE-EXEMPT: offline cache for POS terminal
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .eq("organization_id", organizationId)
        .or("customer_rank.gt.0,type.eq.customer,type.eq.both")
        .eq("is_active", true);

      if (error) throw error;

      const customers = data.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
      }));

      await offlineStorage.clear(STORES.CUSTOMERS);
      await offlineStorage.putBulk(STORES.CUSTOMERS, customers);
      await offlineStorage.updateSyncMeta("customers", new Date().toISOString());

      console.log(`Cached ${customers.length} customers for offline use`);
      return customers.length;
    } catch (error) {
      console.error("Failed to cache customers:", error);
      return 0;
    }
  }

  /**
   * Get cached customers
   */
  async getCachedCustomers(): Promise<Array<{ id: string; name: string; email?: string; phone?: string }>> {
    return offlineStorage.getAll(STORES.CUSTOMERS);
  }

  /**
   * Sync pending transactions
   */
  async syncPendingTransactions(): Promise<{ synced: number; failed: number }> {
    if (!this.isOnline) {
      return { synced: 0, failed: 0 };
    }

    this.notifyStatusChange("syncing");
    
    try {
      const result = await transactionQueue.syncAll();
      await this.notifyQueueCountChange();
      
      // Cleanup completed transactions older than 24 hours
      await transactionQueue.clearCompleted();
      
      return result;
    } finally {
      this.notifyStatusChange(this.isOnline ? "online" : "offline");
    }
  }

  /**
   * Full sync operation
   */
  async fullSync(organizationId: string): Promise<SyncResult> {
    if (!this.isOnline) {
      return {
        success: false,
        transactionsSynced: 0,
        transactionsFailed: 0,
        productsCached: 0,
        customersCached: 0,
        error: "No network connection",
      };
    }

    this.notifyStatusChange("syncing");

    try {
      const [txResult, productCount, customerCount] = await Promise.all([
        this.syncPendingTransactions(),
        this.cacheProducts(organizationId),
        this.cacheCustomers(organizationId),
      ]);

      return {
        success: true,
        transactionsSynced: txResult.synced,
        transactionsFailed: txResult.failed,
        productsCached: productCount,
        customersCached: customerCount,
      };
    } catch (error) {
      return {
        success: false,
        transactionsSynced: 0,
        transactionsFailed: 0,
        productsCached: 0,
        customersCached: 0,
        error: error instanceof Error ? error.message : "Sync failed",
      };
    } finally {
      this.notifyStatusChange(this.isOnline ? "online" : "offline");
    }
  }

  /**
   * Get last sync time for a store
   */
  async getLastSyncTime(store: string): Promise<string | null> {
    const meta = await offlineStorage.getSyncMeta(store);
    return meta?.lastSyncedAt || null;
  }

  /**
   * Cleanup on unmount
   */
  destroy(): void {
    this.stopPeriodicSync();
    this.stopConnectivityChecks();
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    this.statusCallbacks.clear();
    this.queueCountCallbacks.clear();
  }
}

// Singleton instance
export const syncManager = new SyncManager();
