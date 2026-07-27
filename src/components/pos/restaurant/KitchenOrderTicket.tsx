/**
 * Kitchen Order Ticket Component
 * 
 * Individual order card for the kitchen display.
 * Supports grouped orders (multiple items for the same table).
 */

import { KitchenOrder } from "@/hooks/pos/useKitchenDisplay";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  Play,
  Check,
  AlertTriangle,
  Flame,
  Wine,
  IceCream2,
  Utensils,
  Loader2,
  Printer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { submitDocumentIntent } from "@/services/documents/submitIntent";
import { buildKitchenTicketSnapshot } from "@/services/documents/snapshots/posKitchenTicket";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";

interface KitchenOrderTicketProps {
  order: KitchenOrder;
  groupedOrders?: KitchenOrder[];
  onStart?: () => void;
  onComplete?: () => void;
  isStarting?: boolean;
  isCompleting?: boolean;
  showProgress?: boolean;
  isReady?: boolean;
}

const CATEGORY_ICONS = {
  kitchen: Utensils,
  bar: Wine,
  dessert: IceCream2,
  grill: Flame,
};

export function KitchenOrderTicket({
  order,
  groupedOrders,
  onStart,
  onComplete,
  isStarting,
  isCompleting,
  showProgress,
  isReady,
}: KitchenOrderTicketProps) {
  const allOrders = groupedOrders || [order];
  const itemCount = allOrders.length;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Wave 10 — opt-in physical print to the kitchen_printer device. Uses the
  // station from pos_kitchen_orders.printer_category so a single transaction
  // can fan out across stations (kitchen / bar / grill / dessert).
  const [isPrinting, setIsPrinting] = useState(false);
  const handlePrintTicket = async () => {
    const txnId = order.transaction_id;
    if (!txnId) {
      toast.error("Cannot print — order has no transaction reference yet.");
      return;
    }
    setIsPrinting(true);
    try {
      const result = await printClient.printKitchenTicket(txnId, {
        station: order.printer_category,
        table: order.table_number ? String(order.table_number) : null,
        organizationId: currentOrg?.id ?? null,
        businessId: currentBusiness?.id ?? null,
      });
      if (result.success) {
        toast.success(`Sent to ${order.printer_category} printer`);
      } else {
        toast.error(`Print failed: ${result.error ?? "no kitchen printer bound"}`);
      }
    } finally {
      setIsPrinting(false);
    }
  };

  
  // Use the earliest created_at for timing
  const earliestCreatedAt = allOrders.reduce((earliest, o) => {
    const t = new Date(o.created_at).getTime();
    return t < earliest ? t : earliest;
  }, new Date(order.created_at).getTime());
  
  const createdAt = new Date(earliestCreatedAt);
  const minutesWaiting = Math.floor((Date.now() - createdAt.getTime()) / 60000);
  const isUrgent = minutesWaiting > 15;
  const isCritical = minutesWaiting > 25;

  // Collect unique categories
  const categories = [...new Set(allOrders.map(o => o.printer_category))];
  const CategoryIcon = CATEGORY_ICONS[order.printer_category] || Utensils;

  // Collect notes from all orders
  const allNotes = allOrders.filter(o => o.notes).map(o => o.notes!);

  return (
    <Card className={cn(
      "transition-all",
      isReady && "border-green-400 bg-green-50 dark:bg-green-950/30",
      isCritical && !isReady && "border-red-400 bg-red-50 dark:bg-red-950/30 animate-pulse",
      isUrgent && !isCritical && !isReady && "border-amber-400 bg-amber-50 dark:bg-amber-950/30",
      order.priority > 0 && "ring-2 ring-orange-500"
    )}>
      <CardHeader className="p-3 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {order.table_number ? (
              <Badge variant="outline" className="text-lg font-bold px-3">
                T{order.table_number}
              </Badge>
            ) : (
              <Badge variant="secondary">Takeout</Badge>
            )}
            {order.priority > 0 && (
              <Badge variant="destructive" className="gap-1">
                <Flame className="h-3 w-3" />
                RUSH
              </Badge>
            )}
            {itemCount > 1 && (
              <Badge variant="secondary" className="text-xs">
                {itemCount} items
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {categories.map(cat => {
              const Icon = CATEGORY_ICONS[cat] || Utensils;
              return <Icon key={cat} className="h-4 w-4 text-muted-foreground" />;
            })}
            <span className="text-sm text-muted-foreground capitalize">
              {categories.length === 1 ? categories[0] : "mixed"}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-0">
        {/* Order Number */}
        <p className="text-xs text-muted-foreground mb-2">
          #{order.transaction?.transaction_number || order.id.slice(0, 8)}
        </p>

        {/* Grouped Items List */}
        <div className="space-y-1">
          {allOrders.map((o, idx) => (
            <div key={o.id} className="flex items-start gap-2">
              <span className="font-semibold text-sm min-w-[2rem]">1x</span>
              <span className="text-sm flex-1">
                {o.transaction_item_id 
                  ? `Item ${idx + 1}`
                  : `Order item ${idx + 1}`
                }
              </span>
              {o.printer_category !== order.printer_category && (
                <Badge variant="outline" className="text-[10px] px-1">
                  {o.printer_category}
                </Badge>
              )}
            </div>
          ))}
        </div>

        {/* Notes */}
        {allNotes.length > 0 && (
          <div className="mt-2 p-2 bg-muted/50 rounded text-sm space-y-1">
            {allNotes.map((note, i) => (
              <div key={i}>
                <span className="font-medium">Note:</span> {note}
              </div>
            ))}
          </div>
        )}

        {/* Timer */}
        <div className={cn(
          "flex items-center gap-1 mt-3 text-sm",
          isCritical ? "text-red-600 font-bold" : isUrgent ? "text-amber-600" : "text-muted-foreground"
        )}>
          {(isUrgent || isCritical) && <AlertTriangle className="h-4 w-4" />}
          <Clock className="h-4 w-4" />
          <span>{formatDistanceToNow(createdAt)} ago</span>
          <span className="ml-2">({minutesWaiting} min)</span>
        </div>
      </CardContent>

      <CardFooter className="p-3 pt-0">
        {onStart && (
          <Button 
            className="w-full" 
            onClick={onStart}
            disabled={isStarting}
          >
            {isStarting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Start Cooking{itemCount > 1 ? ` (${itemCount})` : ""}
          </Button>
        )}
        
        {onComplete && showProgress && (
          <Button 
            className="w-full bg-green-600 hover:bg-green-700" 
            onClick={onComplete}
            disabled={isCompleting}
          >
            {isCompleting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Mark Ready{itemCount > 1 ? ` (${itemCount})` : ""}
          </Button>
        )}

        {isReady && (
          <div className="w-full text-center">
            <Badge variant="default" className="bg-green-600 text-lg px-4 py-2">
              <Check className="h-4 w-4 mr-2" />
              Ready for Pickup
            </Badge>
          </div>
        )}

        {/* Wave 10 — physical print to the bound kitchen_printer device. */}
        <Button
          variant="ghost"
          size="sm"
          className="ml-2"
          onClick={handlePrintTicket}
          disabled={isPrinting}
          title="Print to kitchen printer"
        >
          {isPrinting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
        </Button>
      </CardFooter>
    </Card>
  );
}
