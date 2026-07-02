import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBackorders } from "@/hooks/useBackorders";
import { Package, ArrowRight, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function BackorderWidget() {
  const { backorders, isLoading } = useBackorders();
  const navigate = useNavigate();

  const pendingBackorders = backorders.filter((b) => b.status === "pending");

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Backorders
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (pendingBackorders.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Backorders
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No pending backorders
          </p>
        </CardContent>
      </Card>
    );
  }

  // Group by product
  const productGroups = pendingBackorders.reduce((acc, bo) => {
    const productId = bo.product_id;
    if (!acc[productId]) {
      acc[productId] = {
        productName: bo.product?.name || "Unknown Product",
        sku: bo.product?.sku,
        totalQuantity: 0,
        orderCount: 0,
      };
    }
    acc[productId].totalQuantity += Number(bo.quantity);
    acc[productId].orderCount += 1;
    return acc;
  }, {} as Record<string, { productName: string; sku: string | null; totalQuantity: number; orderCount: number }>);

  const sortedProducts = Object.entries(productGroups)
    .sort((a, b) => b[1].orderCount - a[1].orderCount)
    .slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" />
          Backorders
          <Badge variant="secondary">{pendingBackorders.length}</Badge>
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => navigate("/inventory-app/stock")}
        >
          View All
          <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedProducts.map(([productId, data]) => (
          <div
            key={productId}
            className="flex items-center justify-between p-3 rounded-lg border bg-card"
          >
            <div className="space-y-1">
              <div className="font-medium text-sm">{data.productName}</div>
              {data.sku && (
                <div className="text-xs text-muted-foreground">SKU: {data.sku}</div>
              )}
            </div>
            <div className="text-right">
              <div className="font-semibold text-sm">{data.totalQuantity} units</div>
              <div className="text-xs text-muted-foreground">
                {data.orderCount} order{data.orderCount !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        ))}
        {Object.keys(productGroups).length > 5 && (
          <p className="text-xs text-muted-foreground text-center">
            +{Object.keys(productGroups).length - 5} more products
          </p>
        )}
      </CardContent>
    </Card>
  );
}
