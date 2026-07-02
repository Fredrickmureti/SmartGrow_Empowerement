/**
 * ReadOnlyBanner
 * 
 * Displays a banner when the user's subscription has expired
 * but they're still allowed to view data in read-only mode.
 */
import { AlertCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReadOnlyMode } from "@/contexts/ReadOnlyModeContext";

export function ReadOnlyBanner() {
  const { isReadOnly, isBlocked, readOnlyMessage, daysUntilExpiry, openUpgrade } = useReadOnlyMode();

  // Don't show if not in a special state
  if (!isReadOnly && !isBlocked && !(daysUntilExpiry !== null && daysUntilExpiry <= 3 && daysUntilExpiry > 0)) {
    return null;
  }

  // Blocked state - red warning
  if (isBlocked) {
    return (
      <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2">
        <div className="container flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm font-medium">{readOnlyMessage}</span>
          </div>
          <Button variant="destructive" size="sm" onClick={openUpgrade}>
            Contact Support
          </Button>
        </div>
      </div>
    );
  }

  // Read-only mode - amber warning
  if (isReadOnly) {
    return (
      <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2">
        <div className="container flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm font-medium">{readOnlyMessage}</span>
          </div>
          <Button size="sm" onClick={openUpgrade} className="gap-1">
            <Sparkles className="h-3 w-3" />
            Upgrade Now
          </Button>
        </div>
      </div>
    );
  }

  // Expiring soon - subtle info
  if (daysUntilExpiry !== null && daysUntilExpiry <= 3 && daysUntilExpiry > 0) {
    return (
      <div className="bg-primary/5 border-b border-primary/10 px-4 py-2">
        <div className="container flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-primary">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">{readOnlyMessage}</span>
          </div>
          <Button variant="outline" size="sm" onClick={openUpgrade} className="gap-1">
            <Sparkles className="h-3 w-3" />
            Renew
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
