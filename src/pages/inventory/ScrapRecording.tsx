/**
 * Scrap / Waste log & dashboard.
 *
 * Reads from `scrap_document_facts`, the canonical scrap reporting view
 * over stock_adjustments, items, movements, warehouses, and GL linkage.
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
import { scrapReasonLabel } from "./scrapReasons";
import { ScrapDetailSheet } from "@/components/inventory/ScrapDetailSheet";
import { useScrapReasons } from "@/hooks/useScrap";

type ScrapRow = {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  adjustment_number: string | null;
  adjustment_date: string;
  reason: string | null;
  notes: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  line_count: number;
  total_quantity: number;
  total_value: number;
  first_product_id: string | null;
  first_product_name: string | null;
  first_product_sku: string | null;
  journal_entry_id: string | null;
  journal_entry_number: string | null;
  warehouse_name: string | null;
  movement_count: number;
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
  const { data: reasonOptions = [] } = useScrapReasons();

  const { data: scraps = [], isLoading } = useQuery({
    queryKey: [
      "scrap-adjustments",
      currentOrg?.id,
      currentBusiness?.id,
      currentBranch?.id,
    ],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [] as ScrapRow[];
      let query = (supabase as any)
        .from("scrap_document_facts")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("adjustment_date", { ascending: false })
        .limit(200);

      if (currentBranch?.id) query = query.eq("branch_id", currentBranch.id);
      const { data, error } = await query;
      if (error) throw error;
      return ((data as any[]) ?? []) as ScrapRow[];
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
      const value = Number(s.total_value || 0);
      if (s.first_product_id) productSet.add(s.first_product_id);

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
                {reasonOptions.map((r) => (
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
                  const qty = Number(s.total_quantity || 0);
                  const value = Number(s.total_value || 0);
                  const extra = s.line_count > 1 ? ` +${s.line_count - 1}` : "";
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
                        {s.first_product_id ? (
                          <button
                            className="text-primary hover:underline text-left"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedProductId(s.first_product_id);
                              setProductDrawerOpen(true);
                            }}
                          >
                            {s.first_product_name ?? "Product"}
                            {extra}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{s.warehouse_name ?? "—"}</TableCell>
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
                        {s.journal_entry_number ?? "—"}
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
