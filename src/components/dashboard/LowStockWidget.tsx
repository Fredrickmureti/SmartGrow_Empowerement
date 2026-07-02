// @ts-nocheck - Tables not in auto-generated types
import { useInventory } from "@/hooks/useInventory";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Package } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function LowStockWidget() {
  const { lowStockProducts, isLoading } = useInventory();
  const navigate = useNavigate();

  if (isLoading || lowStockProducts.length === 0) {
    return null;
  }

  return (
    <Card className="border-warning/50">
      <CardHeader className="pb-3">
        <div className="flex flex-col xs:flex-row xs:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 sm:h-5 sm:w-5 text-warning" />
            <CardTitle className="text-base sm:text-lg">Low Stock Alert</CardTitle>
          </div>
          <Badge variant="outline" className="border-warning text-warning text-xs w-fit">
            {lowStockProducts.length} items
          </Badge>
        </div>
        <CardDescription className="text-xs sm:text-sm">Products below reorder level</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 sm:space-y-3">
        {lowStockProducts.slice(0, 5).map((product) => (
          <div key={product.id} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Package className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground flex-shrink-0" />
              <button
                className="text-xs sm:text-sm font-medium truncate text-primary hover:underline text-left"
                onClick={() => navigate(`/inventory-app/stock?product=${product.id}`)}
                title={`View ${product.name} in inventory`}
              >
                {product.name}
              </button>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              <Badge variant="destructive" className="text-[10px] sm:text-xs px-1.5 sm:px-2">
                {product.stock_quantity} left
              </Badge>
              <span className="text-[10px] sm:text-xs text-muted-foreground hidden xs:inline">
                (min: {product.reorder_level})
              </span>
            </div>
          </div>
        ))}
        
        {lowStockProducts.length > 5 && (
          <p className="text-xs text-muted-foreground text-center">
            +{lowStockProducts.length - 5} more items
          </p>
        )}
        
        <Button 
          variant="outline" 
          className="w-full mt-2 text-xs sm:text-sm h-9 sm:h-10" 
          size="sm"
          onClick={() => navigate("/inventory-app/stock")}
        >
          View Inventory
        </Button>
      </CardContent>
    </Card>
  );
}
