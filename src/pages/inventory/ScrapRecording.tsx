import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useProducts } from "@/hooks/useProducts";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Trash2, Plus, Loader2 } from "lucide-react";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { toast } from "sonner";
import { format } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { normalizeError } from "@/services/resilience";

export default function ScrapRecording() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { products } = useProducts();
  const queryClient = useQueryClient();

  const [showDialog, setShowDialog] = useState(false);
  const [scrapProductDrawerOpen, setScrapProductDrawerOpen] = useState(false);
  const [selectedScrapProductId, setSelectedScrapProductId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scrapForm, setScrapForm] = useState({
    product_id: "",
    warehouse_id: "",
    quantity: 1,
    reason: "",
    notes: "",
  });

  const inventoryProducts = products.filter(p => p.type === "product");

  const [warehouses, setWarehouses] = useState<{id: string; name: string}[]>([]);
  useEffect(() => {
    if (currentOrg?.id) {
      let q = supabase
        .from("warehouses")
        .select("id, name")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      q = q.eq("business_id", currentBusiness!.id);
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
      q.then(({ data }: any) => setWarehouses(data || []));
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

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

  const handleSubmit = async () => {
    if (!currentOrg?.id || !user?.id || !scrapForm.product_id || scrapForm.quantity <= 0) return;
    setIsSubmitting(true);
    try {
      const product = inventoryProducts.find(p => p.id === scrapForm.product_id);
      const costPrice = (product as any)?.cost_price || 0;

      const { data, error } = await supabase.rpc("record_scrap_atomic", {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness?.id || null,
        p_product_id: scrapForm.product_id,
        p_warehouse_id: scrapForm.warehouse_id || null,
        p_quantity: scrapForm.quantity,
        p_unit_cost: costPrice,
        p_reason: scrapForm.reason,
        p_notes: scrapForm.notes || null,
        p_user_id: user.id,
      });

      if (error) throw error;

      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to record scrap");
      }

      toast.success(`Scrap recorded successfully${result.gl_posted ? " (GL posted)" : ""}`);
      setShowDialog(false);
      setScrapForm({ product_id: "", warehouse_id: "", quantity: 1, reason: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["scrap-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    } catch (err: any) {
      toast.error(normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

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
          <Button onClick={() => setShowDialog(true)}>
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

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Scrap / Waste</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Product *</Label>
              <Select value={scrapForm.product_id} onValueChange={v => setScrapForm({ ...scrapForm, product_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {inventoryProducts.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Warehouse</Label>
                <Select value={scrapForm.warehouse_id} onValueChange={v => setScrapForm({ ...scrapForm, warehouse_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                  <SelectContent>
                    {warehouses.map(w => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Quantity *</Label>
                <Input
                  type="number"
                  min={1}
                  value={scrapForm.quantity}
                  onChange={e => setScrapForm({ ...scrapForm, quantity: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Select value={scrapForm.reason} onValueChange={v => setScrapForm({ ...scrapForm, reason: v })}>
                <SelectTrigger><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Damaged">Damaged</SelectItem>
                  <SelectItem value="Expired">Expired</SelectItem>
                  <SelectItem value="Defective">Defective</SelectItem>
                  <SelectItem value="Obsolete">Obsolete</SelectItem>
                  <SelectItem value="Quality Failure">Quality Failure</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Additional Notes</Label>
              <Textarea
                value={scrapForm.notes}
                onChange={e => setScrapForm({ ...scrapForm, notes: e.target.value })}
                placeholder="Optional details..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || !scrapForm.product_id || !scrapForm.reason || scrapForm.quantity <= 0}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Scrap
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProductDetailPanel
        open={scrapProductDrawerOpen}
        onOpenChange={setScrapProductDrawerOpen}
        productId={selectedScrapProductId}
      />
    </div>
  );
}
