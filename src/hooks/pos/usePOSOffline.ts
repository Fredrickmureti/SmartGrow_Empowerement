/**
 * Hook for managing offline/online status and sync in POS
 */

import { useState, useEffect, useCallback } from "react";
import { syncManager } from "@/services/offline";
import { transactionQueue, FailedTransactionInfo } from "@/services/offline/TransactionQueue";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";

type ConnectionStatus = "online" | "offline" | "syncing";

export function usePOSOffline() {
  const { currentOrg } = useOrganization();
  const [status, setStatus] = useState<ConnectionStatus>("online");
  const [queueCount, setQueueCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  // Initialize sync manager
  useEffect(() => {
    if (!currentOrg?.id) return;

    const init = async () => {
      await syncManager.initialize(currentOrg.id);
      setIsInitialized(true);
      
      const lastSync = await syncManager.getLastSyncTime("products");
      setLastSyncTime(lastSync);
    };

    init();

    return () => {
      syncManager.destroy();
    };
  }, [currentOrg?.id]);

  // Subscribe to status changes
  useEffect(() => {
    const unsubStatus = syncManager.onStatusChange((newStatus) => {
      setStatus(newStatus);
      
      // Update Electron tray if available
      const electronTray = window.pos?.tray;
      if (electronTray?.updateStatus) {
        const trayStatus = newStatus === "syncing" ? "syncing" 
          : newStatus === "online" ? "online" : "offline";
        electronTray.updateStatus(trayStatus);
      }
      
      if (newStatus === "offline") {
        toast.warning("You're offline. Transactions will be queued for sync.", {
          duration: 5000,
        });
      } else if (newStatus === "online" && status === "offline") {
        toast.success("Back online! Syncing pending transactions...", {
          duration: 3000,
        });
      }
    });

    const unsubQueue = syncManager.onQueueCountChange((count) => {
      setQueueCount(count);
    });

    // Subscribe to failed transaction notifications
    const unsubFailed = transactionQueue.onTransactionFailed((info: FailedTransactionInfo) => {
      setFailedCount((prev) => prev + 1);
      
      // Update tray to show warning
      const electronTray = window.pos?.tray;
      if (electronTray?.updateStatus) {
        electronTray.updateStatus("warning", `${info.offlineNumber} failed`);
      }
      
      // Show prominent toast notification
      toast.error(`Transaction ${info.offlineNumber} failed after ${info.attempts} attempts`, {
        description: info.error || "Unknown error. Please review in transaction history.",
        duration: 10000,
        action: {
          label: "View Details",
          onClick: () => {
            // Could navigate to transaction history here
            console.log("View failed transaction:", info.id);
          },
        },
      });
    });

    return () => {
      unsubStatus();
      unsubQueue();
      unsubFailed();
    };
  }, [status]);

  // Manual sync trigger
  const triggerSync = useCallback(async () => {
    if (!currentOrg?.id) return;

    try {
      const result = await syncManager.fullSync(currentOrg.id);
      
      if (result.success) {
        setLastSyncTime(new Date().toISOString());
        
        if (result.transactionsSynced > 0) {
          toast.success(`Synced ${result.transactionsSynced} transactions`);
        }
        if (result.transactionsFailed > 0) {
          toast.warning(`${result.transactionsFailed} transactions failed to sync`);
        }
      } else {
        toast.error(result.error || "Sync failed");
      }

      return result;
    } catch (error) {
      toast.error("Sync failed. Please try again.");
      throw error;
    }
  }, [currentOrg?.id]);

  // Refresh product cache
  const refreshProductCache = useCallback(async () => {
    if (!currentOrg?.id) return 0;
    
    const count = await syncManager.cacheProducts(currentOrg.id);
    if (count > 0) {
      toast.success(`Updated ${count} products in offline cache`);
    }
    return count;
  }, [currentOrg?.id]);

  // Force connectivity check (useful for UI refresh buttons)
  const forceConnectivityCheck = useCallback(async () => {
    if (!currentOrg?.id) return false;
    
    const isConnected = await syncManager.forceConnectivityCheck();
    
    if (isConnected && status === "offline") {
      // Trigger sync if we just came back online
      await triggerSync();
    }
    
    return isConnected;
  }, [currentOrg?.id, status, triggerSync]);

  return {
    status,
    isOnline: status === "online" || status === "syncing",
    isOffline: status === "offline",
    isSyncing: status === "syncing",
    queueCount,
    failedCount,
    isInitialized,
    lastSyncTime,
    triggerSync,
    refreshProductCache,
    forceConnectivityCheck,
    checkOnline: () => syncManager.checkOnline(),
    clearFailedCount: () => setFailedCount(0),
  };
}
