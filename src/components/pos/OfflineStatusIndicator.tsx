/**
 * Offline Status Indicator for POS
 * Shows connection status, pending transactions, and sync options
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Wifi,
  WifiOff,
  RefreshCw,
  Cloud,
  CloudOff,
  AlertCircle,
  CheckCircle2,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { usePOSOffline } from "@/hooks/pos/usePOSOffline";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

interface OfflineStatusIndicatorProps {
  className?: string;
  compact?: boolean;
}

export function OfflineStatusIndicator({
  className,
  compact = false,
}: OfflineStatusIndicatorProps) {
  const {
    status,
    isOnline,
    isOffline,
    isSyncing,
    queueCount,
    failedCount,
    lastSyncTime,
    triggerSync,
    clearFailedCount,
  } = usePOSOffline();

  const [isSyncingManual, setIsSyncingManual] = useState(false);

  const handleSync = async () => {
    setIsSyncingManual(true);
    try {
      await triggerSync();
    } finally {
      setIsSyncingManual(false);
    }
  };

  const getStatusIcon = () => {
    if (isSyncing || isSyncingManual) {
      return <Loader2 className="h-4 w-4 animate-spin" />;
    }
    if (isOffline) {
      return <WifiOff className="h-4 w-4" />;
    }
    if (failedCount > 0) {
      return <AlertTriangle className="h-4 w-4" />;
    }
    if (queueCount > 0) {
      return <Cloud className="h-4 w-4" />;
    }
    return <Wifi className="h-4 w-4" />;
  };

  const getStatusColor = () => {
    if (isOffline) return "destructive";
    if (failedCount > 0) return "destructive";
    if (queueCount > 0) return "warning";
    return "success";
  };

  const getStatusText = () => {
    if (isSyncing || isSyncingManual) return "Syncing...";
    if (isOffline) return "Offline";
    if (failedCount > 0) return `${failedCount} failed`;
    if (queueCount > 0) return `${queueCount} pending`;
    return "Online";
  };

  if (compact) {
    return (
      <Badge
        variant={isOffline ? "destructive" : "outline"}
        className={cn(
          "gap-1",
          !isOffline && queueCount === 0 && "border-green-500 text-green-600",
          !isOffline && queueCount > 0 && "border-yellow-500 text-yellow-600",
          className
        )}
      >
        {getStatusIcon()}
        {getStatusText()}
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "gap-2",
            isOffline && "text-destructive",
            !isOffline && queueCount > 0 && "text-yellow-600",
            className
          )}
        >
          {getStatusIcon()}
          <span className="hidden sm:inline">{getStatusText()}</span>
          {queueCount > 0 && !isOffline && (
            <Badge variant="secondary" className="h-5 w-5 p-0 justify-center">
              {queueCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="end">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-full flex items-center justify-center",
                isOffline ? "bg-destructive/10" : "bg-green-500/10"
              )}
            >
              {isOffline ? (
                <CloudOff className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              )}
            </div>
            <div>
              <p className="font-medium">
                {isOffline ? "You're Offline" : "Connected"}
              </p>
              <p className="text-sm text-muted-foreground">
                {isOffline
                  ? "Transactions will be queued"
                  : "All systems operational"}
              </p>
            </div>
          </div>

          {failedCount > 0 && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive">
                  {failedCount} transaction{failedCount !== 1 ? "s" : ""} failed
                </p>
                <p className="text-xs text-destructive/80">
                  Review in transaction history
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => clearFailedCount?.()}
              >
                Dismiss
              </Button>
            </div>
          )}

          {queueCount > 0 && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10">
              <AlertCircle className="h-4 w-4 text-yellow-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-yellow-700">
                  {queueCount} transaction{queueCount !== 1 ? "s" : ""} pending
                </p>
                <p className="text-xs text-yellow-600">
                  Will sync when online
                </p>
              </div>
            </div>
          )}

          {lastSyncTime && (
            <div className="text-sm text-muted-foreground">
              Last synced:{" "}
              <span className="font-medium">
                {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
              </span>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleSync}
            disabled={isOffline || isSyncingManual || isSyncing}
          >
            {isSyncingManual || isSyncing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            {isSyncingManual || isSyncing ? "Syncing..." : "Sync Now"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
