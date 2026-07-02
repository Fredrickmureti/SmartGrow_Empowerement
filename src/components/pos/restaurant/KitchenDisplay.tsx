/**
 * Kitchen Display Component
 * 
 * Full-screen kitchen display system for restaurant mode.
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useKitchenDisplay, KitchenOrder } from "@/hooks/pos/useKitchenDisplay";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  ChefHat, 
  Clock, 
  Check, 
  Play, 
  ArrowLeft,
  Bell,
  AlertTriangle,
  Flame,
  Wine,
  IceCream2,
  Utensils
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { KitchenOrderTicket } from "./KitchenOrderTicket";

const CATEGORY_CONFIG = {
  kitchen: { icon: Utensils, label: "Kitchen", color: "text-orange-600" },
  bar: { icon: Wine, label: "Bar", color: "text-purple-600" },
  dessert: { icon: IceCream2, label: "Dessert", color: "text-pink-600" },
  grill: { icon: Flame, label: "Grill", color: "text-red-600" },
};

export function KitchenDisplay() {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const { 
    orders, 
    isLoading, 
    startOrder, 
    completeOrder, 
    getOrderCounts,
    getAverageWaitTime 
  } = useKitchenDisplay(activeCategory === "all" ? undefined : activeCategory);

  const orderCounts = getOrderCounts();
  const avgWaitTime = getAverageWaitTime();

  // Group orders by transaction (table) for better kitchen visibility
  const groupOrdersByTable = (orderList: KitchenOrder[]) => {
    const groups = new Map<string, KitchenOrder[]>();
    orderList.forEach(order => {
      const key = order.table_number || order.transaction_id || order.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(order);
    });
    return Array.from(groups.entries());
  };

  // Group orders by status (DB enum: new|sent|cooking|ready|served|cancelled)
  const pendingOrders = orders.filter(o => o.status === "new" || o.status === "sent");
  const inProgressOrders = orders.filter(o => o.status === "cooking");
  const readyOrders = orders.filter(o => o.status === "ready");

  const pendingGroups = groupOrdersByTable(pendingOrders);
  const inProgressGroups = groupOrdersByTable(inProgressOrders);
  const readyGroups = groupOrdersByTable(readyOrders);

  return (
    <>
      <div className="h-[calc(100vh-4rem)] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 sm:p-4 border-b bg-background gap-2 sm:gap-0">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate("/pos")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2 min-w-0">
              <ChefHat className="h-5 w-5 sm:h-6 sm:w-6 text-primary shrink-0" />
              <div className="min-w-0">
                <h1 className="text-base sm:text-xl font-semibold truncate">Kitchen Display</h1>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">
                  {orderCounts.total} active orders • Avg wait: {avgWaitTime} min
                </p>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-1.5 sm:gap-2 w-full sm:w-auto overflow-x-auto pl-10 sm:pl-0 pb-1 sm:pb-0">
            <Badge variant="secondary" className="text-xs sm:text-lg px-2 sm:px-3 py-0.5 sm:py-1 whitespace-nowrap shrink-0">
              <Clock className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              {orderCounts.pending} Pending
            </Badge>
            <Badge variant="default" className="text-xs sm:text-lg px-2 sm:px-3 py-0.5 sm:py-1 bg-blue-600 whitespace-nowrap shrink-0">
              <Play className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              {orderCounts.in_progress} Cooking
            </Badge>
            <Badge variant="default" className="text-xs sm:text-lg px-2 sm:px-3 py-0.5 sm:py-1 bg-green-600 whitespace-nowrap shrink-0">
              <Check className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              {orderCounts.ready} Ready
            </Badge>
          </div>
        </div>

        {/* Category Filter */}
        <div className="px-3 sm:px-4 py-2 border-b overflow-x-auto">
          <Tabs value={activeCategory} onValueChange={setActiveCategory}>
            <TabsList className="w-max">
              <TabsTrigger value="all" className="text-xs sm:text-sm">All Stations</TabsTrigger>
              {Object.entries(CATEGORY_CONFIG).map(([key, config]) => {
                const Icon = config.icon;
                return (
                  <TabsTrigger key={key} value={key} className="gap-1 sm:gap-2 text-xs sm:text-sm">
                    <Icon className={cn("h-3.5 w-3.5 sm:h-4 sm:w-4", config.color)} />
                    {config.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        {/* Orders Grid */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 p-3 sm:p-4 overflow-y-auto md:overflow-hidden">
            {/* Pending Column */}
            <div className="flex flex-col min-h-0">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-amber-600" />
                <h2 className="font-semibold text-base sm:text-lg">Pending</h2>
                <Badge variant="outline">{pendingOrders.length}</Badge>
              </div>
              <ScrollArea className="flex-1">
               <div className="space-y-3 pr-2 sm:pr-4">
                  {pendingGroups.map(([tableKey, groupOrders]) => (
                    <KitchenOrderTicket
                      key={tableKey}
                      order={groupOrders[0]}
                      groupedOrders={groupOrders}
                      onStart={() => {
                        // Start all orders in the group
                        groupOrders.forEach(o => startOrder.mutate(o.id));
                      }}
                      isStarting={startOrder.isPending}
                    />
                  ))}
                  {pendingGroups.length === 0 && (
                    <Card className="border-dashed">
                      <CardContent className="py-6 sm:py-8 text-center text-muted-foreground text-sm">
                        No pending orders
                      </CardContent>
                    </Card>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* In Progress Column */}
            <div className="flex flex-col min-h-0">
              <div className="flex items-center gap-2 mb-3">
                <Play className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600" />
                <h2 className="font-semibold text-base sm:text-lg">Cooking</h2>
                <Badge variant="outline">{inProgressOrders.length}</Badge>
              </div>
              <ScrollArea className="flex-1">
               <div className="space-y-3 pr-2 sm:pr-4">
                  {inProgressGroups.map(([tableKey, groupOrders]) => (
                    <KitchenOrderTicket
                      key={tableKey}
                      order={groupOrders[0]}
                      groupedOrders={groupOrders}
                      onComplete={() => {
                        groupOrders.forEach(o => completeOrder.mutate(o.id));
                      }}
                      isCompleting={completeOrder.isPending}
                      showProgress
                    />
                  ))}
                  {inProgressGroups.length === 0 && (
                    <Card className="border-dashed">
                      <CardContent className="py-6 sm:py-8 text-center text-muted-foreground text-sm">
                        No orders cooking
                      </CardContent>
                    </Card>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Ready Column */}
            <div className="flex flex-col min-h-0">
              <div className="flex items-center gap-2 mb-3">
                <Check className="h-4 w-4 sm:h-5 sm:w-5 text-green-600" />
                <h2 className="font-semibold text-base sm:text-lg">Ready</h2>
                <Badge variant="outline">{readyOrders.length}</Badge>
              </div>
              <ScrollArea className="flex-1">
                 <div className="space-y-3 pr-2 sm:pr-4">
                  {readyGroups.map(([tableKey, groupOrders]) => (
                    <KitchenOrderTicket
                      key={tableKey}
                      order={groupOrders[0]}
                      groupedOrders={groupOrders}
                      isReady
                    />
                  ))}
                  {readyGroups.length === 0 && (
                    <Card className="border-dashed">
                      <CardContent className="py-6 sm:py-8 text-center text-muted-foreground text-sm">
                        No orders ready
                      </CardContent>
                    </Card>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default KitchenDisplay;
