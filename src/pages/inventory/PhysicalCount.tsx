import { useState, useEffect, useMemo } from "react";
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
import { ClipboardCheck, Loader2, Save, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { normalizeError } from "@/services/resilience";

interface CountLine {
  product_id: string;
  product_name: string;
  sku: string | null;
  system_qty: number;
  counted_qty: number | null;
  variance: number;
  cost_price: number;
}

export default function PhysicalCount() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { products } = useProducts();
  const queryClient = useQueryClient();

  // Audit lane: every scan dispatched while this screen is mounted lands
  // in `scan_events` with workspace_id='physical_count', branch resolved
  // server-side via the caller's active business membership.
  useActiveScanContext({ workspace_id: "physical_count" });

  const [warehouseFilter, setWarehouseFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<string | null>(null);
  const [countLines, setCountLines] = useState<CountLine[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [countStarted, setCountStarted] = useState(false);

  const [warehouses, setWarehouses] = useState<{id: string; name: string}[]>([]);
  useEffect(() => {
    if (currentOrg?.id && currentBusiness?.id) {
      let q = supabase
        .from("warehouses")
        .select("id, name")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .or("is_in_transit.is.null,is_in_transit.eq.false");
      if (currentBranch?.id) q = q.eq("branch_id", currentBranch.id);
      q.then(({ data }: any) => setWarehouses(data || []));
    }
  }, [currentOrg?.id, currentBusiness?.id, currentBranch?.id]);

  const inventoryProducts = useMemo(
    () => products.filter(p => p.type === "product" && p.track_inventory),
    [products]
  );

  const startCount = async () => {
    // Phase D: warehouse is now MANDATORY. Counts are always per-warehouse —
    // a fallback to products.stock_quantity (company-wide aggregate) silently
    // contaminates the variance with stock from other branches.
    if (!warehouseFilter) {
      toast.error("Pick a warehouse to begin a physical count");
      return;
    }

    let wsq = supabase
      .from("warehouse_stock")
      .select("product_id, quantity")
      .eq("warehouse_id", warehouseFilter)
      .eq("organization_id", currentOrg!.id)
      .eq("business_id", currentBusiness!.id);
    if (currentBranch?.id) wsq = wsq.eq("branch_id", currentBranch.id);
    const { data: warehouseStockData } = await wsq;

    const warehouseQtyMap = new Map<string, number>();
    (warehouseStockData || []).forEach((ws: any) => {
      warehouseQtyMap.set(ws.product_id, ws.quantity || 0);
    });

    const lines: CountLine[] = inventoryProducts.map(p => ({
      product_id: p.id,
      product_name: p.name,
      sku: p.sku,
      system_qty: warehouseQtyMap.get(p.id) ?? 0,
      counted_qty: null,
      variance: 0,
      cost_price: (p as any).cost_price || 0,
    }));

    setCountLines(lines);
    setCountStarted(true);
  };

  const updateCount = (index: number, counted: number | null) => {
    setCountLines(prev => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        counted_qty: counted,
        variance: counted !== null ? counted - updated[index].system_qty : 0,
      };
      return updated;
    });
  };

  /**
   * Scan-to-count: a barcode scan increments the matched product's
   * counted_qty by 1 (starting from system_qty if not yet entered). Unknown
   * codes flash a hint but do not block. Keeps the screen usable with a
   * paired phone or wedge gun for warehouse-floor counting.
   */
  const handleScanCount = async (code: string) => {
    const norm = code.trim();
    if (!norm) return;
    setScanCode("");
    const idx = countLines.findIndex(
      (l) => l.sku && l.sku.toLowerCase() === norm.toLowerCase(),
    );
    if (idx < 0) {
      setScanFlash(`No product matches "${norm}" in this count.`);
      window.setTimeout(() => setScanFlash(null), 2500);
      return;
    }
    const current = countLines[idx];
    const base = current.counted_qty ?? current.system_qty;
    updateCount(idx, base + 1);
    setScanFlash(`+1 ${current.product_name} (now ${base + 1})`);
    window.setTimeout(() => setScanFlash(null), 1500);
  };

  const filteredLines = countLines.filter(line =>
    line.product_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (line.sku && line.sku.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const countedLines = countLines.filter(l => l.counted_qty !== null);
  const varianceLines = countedLines.filter(l => l.variance !== 0);
  const totalPositiveVar = varianceLines.filter(l => l.variance > 0).reduce((s, l) => s + l.variance, 0);
  const totalNegativeVar = varianceLines.filter(l => l.variance < 0).reduce((s, l) => s + Math.abs(l.variance), 0);

  /**
   * Apply adjustments via stock_adjustment workflow:
   * 1. Create stock_adjustment (auto-approved)
   * 2. Create stock_adjustment_items
   * 3. Create stock_movements for each variance
   * 4. Post GL entry (DR/CR Inventory vs Adjustment Expense)
   */
  const handleApplyAdjustments = async () => {
    if (!currentOrg?.id || !user?.id) return;
    const adjustments = varianceLines;
    if (adjustments.length === 0) {
      toast.info("No variances to adjust");
      return;
    }

    setIsSubmitting(true);
    try {
      const lines = adjustments.map(line => ({
        product_id: line.product_id,
        system_qty: line.system_qty,
        counted_qty: line.counted_qty,
        variance: line.variance,
        cost_price: line.cost_price,
      }));

      const { data, error } = await supabase.rpc("apply_physical_count_atomic", {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness?.id || null,
        p_warehouse_id: warehouseFilter || null,
        p_user_id: user.id,
        p_lines: lines,
      });

      if (error) throw error;

      const result = data as any;
      if (!result?.success) {
        throw new Error(result?.error || "Failed to apply physical count");
      }

      toast.success(`${adjustments.length} adjustment(s) applied from physical count${result.gl_posted ? " (GL posted)" : ""}`);
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      queryClient.invalidateQueries({ queryKey: ["stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setCountStarted(false);
      setCountLines([]);
    } catch (err: any) {
      toast.error(normalizeError(err).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!countStarted) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Physical Count</h1>
            <p className="text-sm text-muted-foreground">
              Conduct a physical inventory count and generate adjustment movements
            </p>
          </div>
          <RefreshButton
            queryKeyPrefixes={[
              ["physical-counts"] as const,
              ["stock-adjustments"] as const,
              ["stock-levels-paginated"] as const,
              ["products-list-stock"] as const,
            ]}
            tooltip="Refresh physical count"
          />
        </div>

        <Card className="max-w-lg mx-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              Start New Count
            </CardTitle>
            <CardDescription>
              Pick a warehouse to begin a physical count — counts are always per
              warehouse so the variance applies to the right location.
              {currentBranch?.name ? ` Active branch: ${currentBranch.name}.` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Warehouse <span className="text-destructive">*</span></Label>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map(w => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {warehouses.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No warehouses available in this branch. Create one in Warehouses first.
                </p>
              )}
            </div>
            <Button
              onClick={startCount}
              className="w-full"
              disabled={inventoryProducts.length === 0 || !warehouseFilter}
            >
              <ClipboardCheck className="mr-2 h-4 w-4" />
              Start Count ({inventoryProducts.length} products)
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Physical Count — In Progress</h1>
          <p className="text-sm text-muted-foreground">
            Enter counted quantities. Variances will be highlighted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => { setCountStarted(false); setCountLines([]); }}>
            Cancel
          </Button>
          <ScannerPairingButton
            businessId={currentBusiness?.id}
            branchId={currentBranch?.id ?? null}
            label="Physical count"
          />
          <Button onClick={handleApplyAdjustments} disabled={isSubmitting || varianceLines.length === 0}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Apply {varianceLines.length} Adjustment{varianceLines.length !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>

      <div className="stats-grid grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Products</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{countLines.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Counted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{countedLines.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Surplus (+)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">+{totalPositiveVar}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Shortage (−)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">−{totalNegativeVar}</div>
          </CardContent>
        </Card>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:items-end">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Scan to count</Label>
          <BarcodeInputField
            value={scanCode}
            onChange={setScanCode}
            onScan={(code) => { void handleScanCount(code); }}
            businessId={currentBusiness?.id}
            branchId={currentBranch?.id ?? null}
            allowRepeats
            workflow="count"
            fieldLabel="Physical count"
            placeholder="Scan a barcode to increment its counted qty"
          />
          {scanFlash && (
            <p className="text-xs text-muted-foreground">{scanFlash}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <Input
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">System Qty</TableHead>
                <TableHead className="text-right w-32">Counted Qty</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLines.map((line, idx) => {
                const realIdx = countLines.findIndex(l => l.product_id === line.product_id);
                return (
                  <TableRow key={line.product_id} className={line.variance !== 0 ? "bg-warning/5" : ""}>
                    <TableCell className="font-medium">{line.product_name}</TableCell>
                    <TableCell className="text-muted-foreground">{line.sku || "—"}</TableCell>
                    <TableCell className="text-right">{line.system_qty}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        className="w-24 ml-auto text-right"
                        value={line.counted_qty ?? ""}
                        onChange={e => {
                          const val = e.target.value === "" ? null : parseInt(e.target.value);
                          updateCount(realIdx, val);
                        }}
                        placeholder="—"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {line.counted_qty !== null ? (
                        <span className={
                          line.variance > 0 ? "text-success font-medium" :
                          line.variance < 0 ? "text-destructive font-medium" :
                          "text-muted-foreground"
                        }>
                          {line.variance > 0 ? "+" : ""}{line.variance}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      {line.counted_qty === null ? (
                        <Badge variant="outline">Pending</Badge>
                      ) : line.variance === 0 ? (
                        <Badge className="bg-green-100 text-green-800"><CheckCircle2 className="h-3 w-3 mr-1" />Match</Badge>
                      ) : (
                        <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" />Variance</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
