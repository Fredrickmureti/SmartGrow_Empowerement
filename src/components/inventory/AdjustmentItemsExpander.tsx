import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { StockAdjustmentItem } from "@/hooks/useInventory";

interface AdjustmentItemsExpanderProps {
  items: StockAdjustmentItem[];
}

export function AdjustmentItemsExpander({ items }: AdjustmentItemsExpanderProps) {
  const [expanded, setExpanded] = useState(false);

  if (!items || items.length === 0) return <span className="text-muted-foreground">0 items</span>;

  return (
    <div>
      <button
        className="flex items-center gap-1 text-primary hover:underline text-sm font-medium"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {items.length} item{items.length !== 1 ? "s" : ""}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 pl-4 border-l-2 border-muted">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm py-1">
              <span className="font-medium">{item.products?.name || "Unknown"}</span>
              <div className="flex items-center gap-2">
                <Badge
                  variant={item.quantity_adjustment > 0 ? "default" : "destructive"}
                  className="text-xs"
                >
                  {item.quantity_adjustment > 0 ? "+" : ""}{item.quantity_adjustment}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  ({item.quantity_before} → {item.quantity_after})
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
