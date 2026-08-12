/**
 * Background Sync Manager
 * Handles automatic synchronization with exponential backoff and priority queuing
 */

import { supabase } from "@/integrations/supabase/client";
import { offlineStorage, STORES } from "./OfflineStorageService";
import { transactionQueue } from "./TransactionQueue";

type SyncPriority = "critical" | "high" | "medium" | "low";

interface SyncJob {
  id: string;
  type: string;
  priority: SyncPriority;
  data?: unknown;
  retryCount: number;
  lastAttempt?: string;
  error?: string;
}

interface SyncResult {
  success: boolean;
  synced: number;
  failed: number;
  errors: string[];
}

interface NetworkStatus {
  isOnline: boolean;
  isStable: boolean;
  lastCheck: string;
}

const PRIORITY_ORDER: Record<SyncPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 300000; // 5 minutes
const SYNC_INTERVAL = 30000; // 30 seconds
const STABILITY_CHECK_COUNT = 3;

class BackgroundSyncManager {
  private isRunning = false;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private stabilityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private networkStatus: NetworkStatus = {
    isOnline: navigator.onLine,
    isStable: false,
    lastCheck: new Date().toISOString(),
  };
  private stabilityChecks: boolean[] = [];
  private syncCallbacks: Set<(status: string) => void> = new Set();
  private isElectron = typeof window !== "undefined" && !!window.pos?.isElectron;

  constructor() {
    this.setupNetworkListeners();
  }

  /**
   * Setup network event listeners
   */
  private setupNetworkListeners(): void {
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);

    // Electron-specific network monitoring
    if (this.isElectron && window.pos?.network) {
      window.pos!.network.onStatusChange((isOnline: boolean) => {
        if (isOnline) {
          this.handleOnline();
        } else {
          this.handleOffline();
        }
      });

      window.pos!.network.onRestored(() => {
        this.handleOnline();
      });
    }
  }

  private handleOnline = async (): Promise<void> => {
    console.log("[BackgroundSync] Network connection detected");
    this.networkStatus.isOnline = true;

    // Start stability checks
    this.startStabilityChecks();
  };

  private handleOffline = (): void => {
    console.log("[BackgroundSync] Network connection lost");
    this.networkStatus.isOnline = false;
    this.networkStatus.isStable = false;
    this.stabilityChecks = [];

    this.notifyCallbacks("offline");
    this.stopStabilityChecks();
  };

  /**
   * Start stability checks to ensure connection is reliable
   */
  private startStabilityChecks(): void {
    this.stopStabilityChecks();

    this.stabilityCheckInterval = setInterval(async () => {
      const isConnected = await this.checkRealConnectivity();
      this.stabilityChecks.push(isConnected);

      // Keep only last N checks
      if (this.stabilityChecks.length > STABILITY_CHECK_COUNT) {
        this.stabilityChecks.shift();
      }

      // Connection is stable if all recent checks passed
      const wasStable = this.networkStatus.isStable;
      this.networkStatus.isStable =
        this.stabilityChecks.length >= STABILITY_CHECK_COUNT &&
        this.stabilityChecks.every((check) => check);

      // Trigger sync when connection becomes stable
      if (!wasStable && this.networkStatus.isStable) {
        console.log("[BackgroundSync] Connection stable, triggering sync");
        this.notifyCallbacks("syncing");
        await this.runFullSync();
      }
    }, 2000);
  }

  private stopStabilityChecks(): void {
    if (this.stabilityCheckInterval) {
      clearInterval(this.stabilityCheckInterval);
      this.stabilityCheckInterval = null;
    }
  }

  /**
   * Check real connectivity by making a lightweight request.
   *
   * IMPORTANT: Reachability ≠ authorization. We probe `/auth/v1/health`,
   * which answers 200 with only the anon apikey — the PostgREST root
   * (`/rest/v1/`) also needs an Authorization bearer and otherwise answers
   * 401, which flooded the console on every poll. A 401/403 is still treated
   * as "reachable" below; only network/abort/DNS failure counts as offline.
   */
  private async checkRealConnectivity(): Promise<boolean> {
    try {
      // Use Electron's network check if available
      if (this.isElectron && window.pos?.network?.checkOnline) {
        return await window.pos!.network.checkOnline();
      }

      // Otherwise use fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
        | string
        | undefined;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`,
        {
          method: "GET",
          signal: controller.signal,
          headers: apikey ? { apikey } : undefined,
        },
      );


      clearTimeout(timeout);
      // 2xx = OK, 401/403 = server reachable but unauthenticated (still "online")
      return (
        response.ok ||
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      );
    } catch {
      // Only true network failure (abort, DNS, offline) lands here
      return false;
    }
  }

  /**
   * Subscribe to sync status changes
   */
  onSyncStatusChange(callback: (status: string) => void): () => void {
    this.syncCallbacks.add(callback);
    return () => this.syncCallbacks.delete(callback);
  }

  private notifyCallbacks(status: string): void {
    this.syncCallbacks.forEach((cb) => cb(status));
  }

  /**
   * Start background sync
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log("[BackgroundSync] Started");

    // Initial sync if online
    if (this.networkStatus.isOnline) {
      this.runFullSync();
    }

    // Periodic sync
    this.syncInterval = setInterval(async () => {
      if (this.networkStatus.isOnline && this.networkStatus.isStable) {
        await this.runIncrementalSync();
      }
    }, SYNC_INTERVAL);
  }

  /**
   * Stop background sync
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    console.log("[BackgroundSync] Stopped");

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.stopStabilityChecks();
  }

  /**
   * Run full sync (all pending items)
   */
  async runFullSync(): Promise<SyncResult> {
    if (!this.networkStatus.isOnline) {
      return { success: false, synced: 0, failed: 0, errors: ["Offline"] };
    }

    this.notifyCallbacks("syncing");

    const result: SyncResult = {
      success: true,
      synced: 0,
      failed: 0,
      errors: [],
    };

    try {
      // Sync transactions (critical priority)
      const txResult = await transactionQueue.syncAll();
      result.synced += txResult.synced;
      result.failed += txResult.failed;

      // Update sync status in Electron
      if (this.isElectron && window.pos?.offline?.updateSyncStatus) {
        await window.pos!.offline.updateSyncStatus({
          lastSyncAt: new Date().toISOString(),
          pendingCount: await transactionQueue.getQueueCount(),
          failedCount: (await transactionQueue.getFailedTransactions()).length,
        });
      }

      // Update local sync metadata
      await offlineStorage.updateSyncMeta("last_full_sync", new Date().toISOString());

      this.notifyCallbacks("online");
      console.log(`[BackgroundSync] Full sync complete: ${result.synced} synced, ${result.failed} failed`);
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : "Unknown error");
      this.notifyCallbacks("error");
    }

    return result;
  }

  /**
   * Run incremental sync (only new items since last sync)
   */
  async runIncrementalSync(): Promise<SyncResult> {
    if (!this.networkStatus.isOnline) {
      return { success: false, synced: 0, failed: 0, errors: ["Offline"] };
    }

    const result: SyncResult = {
      success: true,
      synced: 0,
      failed: 0,
      errors: [],
    };

    try {
      // Only sync pending transactions
      const pendingCount = await transactionQueue.getQueueCount();
      
      if (pendingCount > 0) {
        this.notifyCallbacks("syncing");
        const txResult = await transactionQueue.syncAll();
        result.synced += txResult.synced;
        result.failed += txResult.failed;
        this.notifyCallbacks("online");
      }

      // Update Electron sync status
      if (this.isElectron && window.pos?.offline?.updateSyncStatus) {
        await window.pos!.offline.updateSyncStatus({
          lastSyncAt: new Date().toISOString(),
          pendingCount: await transactionQueue.getQueueCount(),
        });
      }
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : "Unknown error");
    }

    return result;
  }

  /**
   * Force immediate sync
   */
  async forceSync(): Promise<SyncResult> {
    return this.runFullSync();
  }

  /**
   * Get current network status
   */
  getNetworkStatus(): NetworkStatus {
    return { ...this.networkStatus };
  }

  /**
   * Get sync queue status
   */
  async getQueueStatus(): Promise<{
    pending: number;
    failed: number;
    lastSync: string | null;
  }> {
    const pending = await transactionQueue.getQueueCount();
    const failed = (await transactionQueue.getFailedTransactions()).length;
    const lastSyncMeta = await offlineStorage.getSyncMeta("last_full_sync");

    return {
      pending,
      failed,
      lastSync: lastSyncMeta?.lastSyncedAt || null,
    };
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryCount: number): number {
    const delay = BASE_RETRY_DELAY * Math.pow(2, retryCount);
    return Math.min(delay, MAX_RETRY_DELAY);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);

    if (this.isElectron && window.pos?.network?.removeAllListeners) {
      window.pos!.network.removeAllListeners();
    }

    this.syncCallbacks.clear();
  }
}

// Singleton instance
export const backgroundSyncManager = new BackgroundSyncManager();
