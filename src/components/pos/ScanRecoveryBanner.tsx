/**
 * ScanRecoveryBanner — non-modal recovery affordance for unknown scans.
 *
 * Rendered above the cart, never blocks scanning. Gives the cashier
 * one-click escapes from a code the system couldn't resolve:
 *   1. Open the product search prefilled with the raw code.
 *   2. Open the Inventory product form pre-filled with the barcode as the
 *      first identifier (fixes the catalog gap without leaving the POS flow).
 *   3. Dismiss.
 *
 * Auto-dismissed by the terminal whenever the next scan resolves cleanly.
 */
import { AlertTriangle, Search, X, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  code: string | null;
  reason?: string;
  onSearch: (code: string) => void;
  onCreateProduct?: (code: string) => void;
  onDismiss: () => void;
}

export function ScanRecoveryBanner({ code, reason, onSearch, onCreateProduct, onDismiss }: Props) {
  if (!code) return null;
  return (
    <div
      role="alert"
      className={cn(
        "mx-3 mt-2 mb-1 rounded-md border border-destructive/40 bg-destructive/10",
        "px-3 py-2 flex items-center gap-2 text-sm",
      )}
    >
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">{reason || "Unknown barcode"}</span>
        <span className="ml-2 font-mono text-xs text-muted-foreground truncate">
          {code}
        </span>
      </div>
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onSearch(code)}>
        <Search className="h-3.5 w-3.5 mr-1" /> Search
      </Button>
      {onCreateProduct && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          onClick={() => onCreateProduct(code)}
          title="Create a new product with this barcode"
        >
          <PackagePlus className="h-3.5 w-3.5 mr-1" /> Create
        </Button>
      )}
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onDismiss} aria-label="Dismiss">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
