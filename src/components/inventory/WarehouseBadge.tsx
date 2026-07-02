/**
 * WarehouseBadge — companion to ActiveBranchBadge.
 *
 * Shows the warehouse the operator is acting against. Useful on POS and
 * goods-receipt / delivery surfaces where stock physically moves and silent
 * fallbacks would be dangerous.
 */
import { Badge } from "@/components/ui/badge";
import { Warehouse } from "lucide-react";

interface WarehouseBadgeProps {
  warehouseName?: string | null;
  variant?: "default" | "secondary" | "destructive" | "outline";
}

export function WarehouseBadge({ warehouseName, variant = "secondary" }: WarehouseBadgeProps) {
  if (!warehouseName) {
    return (
      <Badge variant="destructive" className="gap-1.5">
        <Warehouse className="h-3 w-3" />
        No warehouse
      </Badge>
    );
  }
  return (
    <Badge variant={variant} className="gap-1.5">
      <Warehouse className="h-3 w-3" />
      {warehouseName}
    </Badge>
  );
}
