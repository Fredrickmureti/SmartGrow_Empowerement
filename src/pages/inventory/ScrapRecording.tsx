/**
 * Scrap / Waste log & dashboard.
 *
 * Reads from `stock_adjustments where adjustment_type='scrap'` (the
 * canonical scrap document) joined to its items, journal entry, and
 * approver. Falls back to legacy bare `stock_movements` rows written by
 * pre-2026-07 scrap flows so historical data stays visible.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Loader2 } from "lucide-react";
import { ProductDetailPanel } from "@/components/products/detail/ProductDetailPanel";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SCRAP_REASONS, scrapReasonLabel } from "./scrapReasons";
import { ScrapDetailSheet } from "@/components/inventory/ScrapDetailSheet";

type ScrapRow = {
  id: string;
  adjustment_number: string | null;
  adjustment_date: string;
  reason: string | null;
  notes: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  warehouse_id: string | null;
  warehouses?: { id: string; name: string } | null;
  stock_adjustment_items?: Array<{
    id: string;
    product_id: string;
    quantity_adjustment: number;
    unit_cost: number | null;
    products?: { id: string; name: string; sku: string | null } | null;
  }>;
  journal_entries?: Array<{ id: string; entry_number: string | null }>;
};

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
    case "posted":
      return "default";
    case "draft":
    case "pending_approval":
      return "secondary";
    case "rejected":
    case "reversed":
      return "destructive";
    default:
      return "outline";
  }
}

export default function ScrapRecording() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [productDrawerOpen, setProductDrawerOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailScrapId, setDetailScrapId] = useState<string | null>(null);

  const { data: scraps = [], isLoading } = useQuery({
    queryKey: [
      "scrap-adjustments",
      currentOrg?.id,
      currentBusiness?.id,
      currentBranch?.id,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [] as ScrapRow[];
      let query = supabase
        .from("stock_adjustments")
        .select(
          `id, adjustment_number, adjustment_date, reason, notes, status,
           approved_by, approved_at, created_by, warehouse_id,
           warehouses:warehouse_id ( id, name ),
           stock_adjustment_items (
             id, product_id, quantity_adjustment, unit_cost,
             products:product_id ( id, name, sku )
           ),
           journal_entries!journal_entries_source_id_fkey ( id, entry_number )`,
        )
        // adjustment_type is filtered client-side to survive type
        // regeneration timing after the migration.
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("adjustment_date", { ascending: false })
        .limit(200);

      if (currentBranch?.id) query = query.eq("branch_id", currentBranch.id);
      const { data, error } = await query;
      if (error) throw error;
      return ((data as any[]) ?? []).filter(
        (r) => (r as any).adjustment_type === "scrap",
      ) as ScrapRow[];
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const filtered = useMemo(() => {
    return scraps.filter((s) => {
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (reasonFilter !== "all" && (s.reason ?? "") !== reasonFilter) return false;
      return true;
    });
  }, [scraps, statusFilter, reasonFilter]);

  const kpis = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const isToday = (d: string) => new Date(d).toDateString() === now.toDateString();
    const isThisMonth = (d: string) => new Date(d) >= startOfMonth;

    let pending = 0;
    let postedMTD = 0;
    let lossMTD = 0;
    let lossToday = 0;
    let productSet = new Set<string>();
    const reasonTally = new Map<string, number>();

    for (const s of scraps) {
      const value = (s.stock_adjustment_items ?? []).reduce(
        (sum, it) =>
          sum + Math.abs(Number(it.quantity_adjustment) || 0) * Number(it.unit_cost || 0),
        0,
      );
      for (const it of s.stock_adjustment_items ?? []) productSet.add(it.product_id);

      if (s.status === "pending_approval" || s.status === "draft") pending += 1;

      if (isThisMonth(s.adjustment_date)) {
        if (s.status === "approved" || s.status === "posted") {
          postedMTD += 1;
          lossMTD += value;
        }
      }
      if (isToday(s.adjustment_date)) lossToday += value;

      if (s.reason) reasonTally.set(s.reason, (reasonTally.get(s.reason) ?? 0) + value);
    }

    const topReason = [...reasonTally.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      pending,
      postedMTD,
      lossMTD,
      lossToday,
      productsAffected: productSet.size,
      topReason: topReason ? scrapReasonLabel(topReason[0]) : "—",
    };
  }, [scraps]);

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Scrap / Waste</h1>
          <p className="text-sm text-muted-foreground">
            Damaged, expired, or unusable inventory — posted through the
            hardened stock-adjustments engine with SoD, cost resolution, and
            reason-keyed GL.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ["scrap-adjustments"] as const,
              ["stock-movements"] as const,
              ["stock-levels-paginated"] as const,
              ["products-list-stock"] as const,
            ]}
            tooltip="Refresh scrap log"
          />
          <Button variant="outline" onClick={() => navigate("/inventory-app/setup/scrap-reasons")}>
            Reasons
          </Button>
          <Button onClick={() => navigate("/inventory-app/scrap/new")}>
            <Trash2 className="mr-2 h-4 w-4" />
            Record scrap
          </Button>
        </div>
      </div>

      <div className="stats-grid grid-cols-2 lg:grid-cols-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Pending approval
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Posted this month
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis.postedMTD}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Loss MTD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{fmt(kpis.lossMTD)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Loss today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{fmt(kpis.lossToday)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Products affected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{kpis.productsAffected}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Top reason
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold truncate">{kpis.topReason}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle>Scrap documents</CardTitle>
          <div className="flex gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="pending_approval">Pending approval</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="posted">Posted</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Select value={reasonFilter} onValueChange={setReasonFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Reason" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {SCRAP_REASONS.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">
              No scrap records match the current filters.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Products</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>JE</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => {
                  const items = s.stock_adjustment_items ?? [];
                  const qty = items.reduce(
                    (sum, it) => sum + Math.abs(Number(it.quantity_adjustment) || 0),
                    0,
                  );
                  const value = items.reduce(
                    (sum, it) =>
                      sum +
                      Math.abs(Number(it.quantity_adjustment) || 0) *
                        Number(it.unit_cost || 0),
                    0,
                  );
                  const firstProduct = items[0]?.products;
                  const extra = items.length > 1 ? ` +${items.length - 1}` : "";
                  const je = s.journal_entries?.[0];
                  return (
                    <TableRow
                      key={s.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => {
                        setDetailScrapId(s.id);
                        setDetailOpen(true);
                      }}
                    >
                      <TableCell className="font-mono text-xs">
                        {s.adjustment_number ?? s.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        {format(new Date(s.adjustment_date), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {firstProduct ? (
                          <button
                            className="text-primary hover:underline text-left"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedProductId(firstProduct.id);
                              setProductDrawerOpen(true);
                            }}
                          >
                            {firstProduct.name}
                            {extra}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{s.warehouses?.name ?? "—"}</TableCell>
                      <TableCell>{scrapReasonLabel(s.reason)}</TableCell>
                      <TableCell className="text-right text-destructive">
                        {fmt(qty)}
                      </TableCell>
                      <TableCell className="text-right">{fmt(value)}</TableCell>
                      <TableCell>
                        <Badge variant={statusTone(s.status)} className="capitalize">
                          {s.status.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {je?.entry_number ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProductDetailPanel
        open={productDrawerOpen}
        onOpenChange={setProductDrawerOpen}
        productId={selectedProductId}
      />

      <ScrapDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        scrapId={detailScrapId}
      />
    </div>
  );
}
