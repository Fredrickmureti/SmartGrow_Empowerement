/**
 * Offline Banner Component
 * Persistent banner shown when user is working offline
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, RefreshCw, AlertTriangle, X, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { backgroundSyncManager } from "@/services/offline/BackgroundSyncManager";
import { transactionQueue } from "@/services/offline";
import { cn } from "@/lib/utils";

interface OfflineBannerProps {
  className?: string;
  onDismiss?: () => void;
  showDismiss?: boolean;
}

export function OfflineBanner({
  className,
  onDismiss,
  showDismiss = false,
}: OfflineBannerProps) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => {
      setIsOnline(false);
      setIsDismissed(false); // Show banner again when going offline
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Subscribe to sync status
    const unsubscribe = backgroundSyncManager.onSyncStatusChange((status) => {
      setIsSyncing(status === "syncing");
      if (status === "online") {
        setIsOnline(true);
      }
    });

    // Get initial pending count
    transactionQueue.getQueueCount().then(setPendingCount);

    // Poll pending count
    const interval = setInterval(async () => {
      const count = await transactionQueue.getQueueCount();
      setPendingCount(count);
    }, 5000);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await backgroundSyncManager.forceSync();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  // Don't show if online and no pending transactions, or if dismissed
  if ((isOnline && pendingCount === 0) || isDismissed) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -100, opacity: 0 }}
        transition={{ type: "spring", damping: 20 }}
        className={cn(
          "fixed top-0 left-0 right-0 z-50",
          "bg-gradient-to-r",
          !isOnline
            ? "from-destructive/90 to-destructive/80"
            : pendingCount > 0
            ? "from-yellow-600/90 to-amber-600/80"
            : "from-primary/90 to-primary/80",
          "text-white shadow-lg",
          className
        )}
      >
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/20 rounded-full">
                {!isOnline ? (
                  <WifiOff className="h-5 w-5" />
                ) : pendingCount > 0 ? (
                  <CloudOff className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </div>
              <div>
                <p className="font-semibold">
                  {!isOnline
                    ? "You're working offline"
                    : `${pendingCount} transaction${pendingCount !== 1 ? "s" : ""} pending sync`}
                </p>
                <p className="text-sm text-white/80">
                  {!isOnline
                    ? "Transactions will be saved and synced when you're back online"
                    : "Click sync to upload pending transactions"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isOnline && pendingCount > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="bg-white/20 hover:bg-white/30 text-white border-0"
                >
                  <RefreshCw
                    className={cn("h-4 w-4 mr-2", isSyncing && "animate-spin")}
                  />
                  {isSyncing ? "Syncing..." : "Sync Now"}
                </Button>
              )}

              {showDismiss && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleDismiss}
                  className="text-white/80 hover:text-white hover:bg-white/20"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Progress indicator when syncing */}
          {isSyncing && (
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 2, repeat: Infinity }}
              className="absolute bottom-0 left-0 right-0 h-1 bg-white/30 origin-left"
            />
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
