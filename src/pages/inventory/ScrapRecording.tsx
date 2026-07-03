import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Loader2 } from "lucide-react";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { RefreshButton } from "@/components/ui/RefreshButton";

export default function ScrapRecording() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const [scrapProductDrawerOpen, setScrapProductDrawerOpen] = useState(false);
  const [selectedScrapProductId, setSelectedScrapProductId] = useState<string | null>(null);

  // Fetch recent scrap movements
  const { data: scrapMovements = [], isLoading } = useQuery({
    queryKey: ["scrap-movements", currentOrg?.id, currentBusiness?.id, currentBranch?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      let query = supabase
        .from("stock_movements")
        .select("*, products(id, name, sku), warehouses(id, name)")
        .eq("organization_id", currentOrg.id)
        .eq("movement_type", "scrap")
        .order("movement_date", { ascending: false })
        .limit(100);
      query = query.eq("business_id", currentBusiness!.id);
      if (currentBranch?.id) query = query.eq("branch_id", currentBranch.id);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!currentOrg?.id,
  });

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Scrap / Waste Recording</h1>
          <p className="text-sm text-muted-foreground">Record damaged, expired, or unusable inventory</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ["stock-movements"] as const,
              ["scrap-movements"] as const,
              ["stock-levels-paginated"] as const,
              ["products-list-stock"] as const,
            ]}
            tooltip="Refresh scrap log"
          />
          <Button onClick={() => navigate("/inventory-app/scrap/new")}>
            <Trash2 className="mr-2 h-4 w-4" />
            Record Scrap
          </Button>
        </div>
      </div>

      <div className="stats-grid grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Scrap Events</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{scrapMovements.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Units Scrapped</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {scrapMovements.reduce((sum: number, m: any) => sum + Math.abs(m.quantity), 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Products Affected</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {new Set(scrapMovements.map((m: any) => m.product_id)).size}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Scrap Records</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : scrapMovements.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No scrap records yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Qty Scrapped</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scrapMovements.map((m: any) => (
                  <TableRow key={m.id}>
                    <TableCell>{format(new Date(m.movement_date), "MMM d, yyyy")}</TableCell>
                    <TableCell className="font-medium">
                      {m.products?.name ? (
                        <button
                          className="text-primary hover:underline text-left"
                          onClick={() => {
                            setSelectedScrapProductId(m.product_id);
                            setScrapProductDrawerOpen(true);
                          }}
                        >
                          {m.products.name}
                        </button>
                      ) : "—"}
                    </TableCell>
                    <TableCell>{m.warehouses?.name || "Default"}</TableCell>
                    <TableCell className="text-right text-destructive font-medium">{Math.abs(m.quantity)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {m.unit_cost ? (Math.abs(m.quantity) * m.unit_cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{m.notes || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProductDetailPanel
        open={scrapProductDrawerOpen}
        onOpenChange={setScrapProductDrawerOpen}
        productId={selectedScrapProductId}
      />
    </div>
  );
}
