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
import { ClipboardCheck, Loader2, Save, AlertTriangle, CheckCircle2, ArrowLeft, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { useResolveProductIdentity } from "@/hooks/inventory/useResolveProductIdentity";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { normalizeError } from "@/services/resilience";
import {
  WizardShell,
  WizardStepper,
  RecordHeader,
  FooterActionBar,
  ActionBar,
  type WizardStep,
} from "@/design-system";

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
  // Phase C3 — counts resolve identity through the canonical resolver so a
  // case scan counts its full base-unit content, not "1".
  const { resolve: resolveIdentity } = useResolveProductIdentity(
    currentBusiness?.id,
    currentBranch?.id ?? null,
    // Typing path: an operator may key a SKU into the count box.
    { allowSkuFallback: true },
  );
  const { user } = useAuth();
  const { products } = useProducts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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
  const [step, setStep] = useState<"scope" | "count" | "review">("scope");

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
    setStep("count");
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

    const flash = (msg: string, ms = 2500) => {
      setScanFlash(msg);
      window.setTimeout(() => setScanFlash(null), ms);
    };

    const resolved = await resolveIdentity(norm);
    if (resolved.kind !== "resolved" && resolved.kind !== "not_found") {
      // Ambiguous / retired / expired / offline all block the count line.
      flash(
        identityOutcomeLine({
          status: resolved.kind,
          code: norm,
          matchCount: resolved.kind === "ambiguous" ? resolved.matchCount : undefined,
        }),
        3500,
      );
      return;
    }

    let idx = -1;
    let step = 1;
    if (resolved.kind === "resolved") {
      const identity = resolved.identity;
      step = Math.max(1, Math.round(identity.qtyInBaseUom || 1));
      idx = countLines.findIndex((l) => l.product_id === identity.productId);
      if (idx < 0) {
        flash(`${identity.productName} is not in this count.`);
        return;
      }
    } else {
      // Unknown identifier — fall back to a literal SKU match so a
      // not-yet-enrolled product can still be counted by typing its SKU.
      idx = countLines.findIndex(
        (l) => l.sku && l.sku.toLowerCase() === norm.toLowerCase(),
      );
      if (idx < 0) {
        flash(`No product matches "${norm}" in this count.`);
        return;
      }
    }

    const current = countLines[idx];
    const base = current.counted_qty ?? current.system_qty;
    updateCount(idx, base + step);
    flash(`+${step} ${current.product_name} (now ${base + step})`, 1500);
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
    const counted = countedLines;
    if (varianceLines.length === 0) {
      toast.info("No variances to adjust");
      return;
    }

    setIsSubmitting(true);
    try {
      // D5: shim retired — drive the lifecycle RPCs and hand off to the
      // detail workspace so a different user can approve + post (SoD).
      // NOTE: must call `supabase.rpc(...)` directly — extracting it into a
      // local binding drops `this` and blows up inside supabase-js with
      // "Cannot read properties of undefined (reading 'rest')".
      const rpc = <T = unknown>(n: string, a: Record<string, unknown>) =>
        (supabase.rpc as unknown as (name: string, args: Record<string, unknown>) => Promise<{ data: T; error: { message: string; code?: string; details?: string; hint?: string } | null }>).call(
          supabase, n, a,
        );

      const created = await rpc<string>("physical_count_create", {
        p_organization_id: currentOrg.id,
        p_business_id: currentBusiness?.id || null,
        p_warehouse_id: warehouseFilter,
        p_user_id: user.id,
        p_count_type: "full",
      });
      if (created.error) throw created.error;
      const countId = created.data as string;

      const frozen = await rpc("physical_count_freeze", { p_count_id: countId, p_user_id: user.id });
      if (frozen.error) throw frozen.error;

      for (const line of counted) {
        const rec = await rpc("physical_count_record_line", {
          p_count_id: countId,
          p_product_id: line.product_id,
          p_counted_qty: line.counted_qty,
          p_user_id: user.id,
        });
        if (rec.error) throw rec.error;
      }

      const submitted = await rpc("physical_count_submit", {
        p_count_id: countId,
        p_user_id: user.id,
      });
      if (submitted.error) throw submitted.error;

      toast.success(`Count submitted for review — open the workspace to approve & post`);
      queryClient.invalidateQueries({ queryKey: ["physical-counts-workspace"] });
      navigate(`/inventory-app/physical-counts/${countId}`);
    } catch (err: any) {
      // Surface the true cause — never mask with a generic "unexpected error".
      // eslint-disable-next-line no-console
      console.error("[PhysicalCount] handleApplyAdjustments failed", {
        message: err?.message,
        code: err?.code,
        details: err?.details,
        hint: err?.hint,
        raw: err,
      });
      const rawMsg = (err?.message || "").trim();
      const parts = [
        rawMsg,
        err?.details ? `Details: ${err.details}` : null,
        err?.hint ? `Hint: ${err.hint}` : null,
        err?.code ? `Code: ${err.code}` : null,
      ].filter(Boolean) as string[];
      const shown = parts.length > 0 ? parts.join(" · ") : normalizeError(err).message;
      toast.error(shown);
    } finally {
      setIsSubmitting(false);
    }
  };


  const steps: WizardStep[] = [
    { id: "scope", label: "Scope", description: "Pick warehouse" },
    { id: "count", label: "Count", description: "Enter counted qty" },
    { id: "review", label: "Review & post", description: "Confirm variance" },
  ];
  const completed =
    step === "count" ? ["scope"] : step === "review" ? ["scope", "count"] : [];

  const header = (
    <RecordHeader
      eyebrow="Inventory"
      title="Physical Count"
      meta={
        <span className="text-xs text-muted-foreground">
          {currentBranch?.name ? `Branch: ${currentBranch.name}` : "All branches"}
        </span>
      }
      actions={
        <ActionBar>
          <RefreshButton
            queryKeyPrefixes={[
              ["physical-counts"] as const,
              ["stock-adjustments"] as const,
              ["stock-levels-paginated"] as const,
              ["products-list-stock"] as const,
            ]}
            tooltip="Refresh physical count"
          />
        </ActionBar>
      }
    />
  );

  const stepper = (
    <WizardStepper
      steps={steps}
      activeStepId={step}
      completedStepIds={completed}
      onStepClick={(id) => setStep(id as typeof step)}
    />
  );

  const renderScope = () => (
    <Card className="mx-auto max-w-xl">
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
              {warehouses.map((w) => (
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
      </CardContent>
    </Card>
  );

  const renderCount = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
          <CardContent><div className="text-2xl font-bold text-primary">{countedLines.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Surplus (+)</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-success">+{totalPositiveVar}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Shortage (−)</CardTitle>
          </CardHeader>
          <CardContent><div className="text-2xl font-bold text-destructive">−{totalNegativeVar}</div></CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
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
          {scanFlash && <p className="text-xs text-muted-foreground">{scanFlash}</p>}
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
              {filteredLines.map((line) => {
                const realIdx = countLines.findIndex((l) => l.product_id === line.product_id);
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
                        onChange={(e) => {
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

  const renderReview = () => (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Variance summary</CardTitle>
          <CardDescription>
            {varianceLines.length === 0
              ? "No variances detected — nothing to post."
              : `Posting ${varianceLines.length} adjustment${varianceLines.length !== 1 ? "s" : ""} will create stock movements and a balanced GL entry.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div><div className="text-xs text-muted-foreground">Counted lines</div><div className="text-xl font-semibold">{countedLines.length}</div></div>
          <div><div className="text-xs text-muted-foreground">Variances</div><div className="text-xl font-semibold">{varianceLines.length}</div></div>
          <div><div className="text-xs text-muted-foreground">Surplus</div><div className="text-xl font-semibold text-success">+{totalPositiveVar}</div></div>
          <div><div className="text-xs text-muted-foreground">Shortage</div><div className="text-xl font-semibold text-destructive">−{totalNegativeVar}</div></div>
        </CardContent>
      </Card>
      {varianceLines.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">System</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="text-right">Cost impact</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {varianceLines.map((l) => (
                  <TableRow key={l.product_id}>
                    <TableCell className="font-medium">{l.product_name}</TableCell>
                    <TableCell className="text-right">{l.system_qty}</TableCell>
                    <TableCell className="text-right">{l.counted_qty}</TableCell>
                    <TableCell className={`text-right font-medium ${l.variance > 0 ? "text-success" : "text-destructive"}`}>
                      {l.variance > 0 ? "+" : ""}{l.variance}
                    </TableCell>
                    <TableCell className="text-right">{(l.variance * l.cost_price).toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );

  const footer = (
    <FooterActionBar
      leading={
        step !== "scope" ? (
          <Button
            variant="ghost"
            onClick={() => setStep(step === "review" ? "count" : "scope")}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
          </Button>
        ) : null
      }
      trailing={
        <ActionBar>
          {step === "count" && (
            <ScannerPairingButton
              businessId={currentBusiness?.id}
              branchId={currentBranch?.id ?? null}
              label="Physical count"
            />
          )}
          {step === "scope" && (
            <Button
              onClick={startCount}
              disabled={inventoryProducts.length === 0 || !warehouseFilter}
            >
              <ClipboardCheck className="mr-2 h-4 w-4" />
              Start Count ({inventoryProducts.length} products)
            </Button>
          )}
          {step === "count" && (
            <Button onClick={() => setStep("review")} disabled={countedLines.length === 0}>
              Continue to review <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          )}
          {step === "review" && (
            <Button
              onClick={handleApplyAdjustments}
              disabled={isSubmitting || varianceLines.length === 0}
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Post {varianceLines.length} Adjustment{varianceLines.length !== 1 ? "s" : ""}
            </Button>
          )}
        </ActionBar>
      }
    />
  );

  return (
    <WizardShell header={header} stepper={stepper} footer={footer}>
      {step === "scope" && renderScope()}
      {step === "count" && renderCount()}
      {step === "review" && renderReview()}
    </WizardShell>
  );
}
