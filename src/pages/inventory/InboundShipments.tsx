/**
 * InboundShipments — Advance Shipping Notice (ASN) list.
 *
 * Phase D.3 · Inventory Foundation Audit. Renders every row in
 * `inbound_shipments` scoped to the active org/business, offers a
 * CSV import shortcut backed by `createAsnBatchImportHandler`, and
 * links each shipment to its detail view (which in turn launches the
 * Goods Receipt wizard).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import {
  ASN_IMPORT_FIELDS,
  createAsnBatchImportHandler,
  type AsnProductResolver,
} from "@/lib/importConfigs";
import { ImportWizard } from "@/components/common/ImportWizard";
import type { BatchImportFn, ImportResults } from "@/hooks/useImport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Search, Upload, Truck, PackageOpen } from "lucide-react";
import { format } from "date-fns";

interface ShipmentRow {
  id: string;
  shipment_number: string;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
  dispatched_at: string | null;
  expected_arrival_at: string | null;
  purchase_order_id: string | null;
  created_at: string;
  items_count?: number;
}

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  dispatched: "default",
  in_transit: "default",
  arrived: "outline",
  received: "default",
  cancelled: "destructive",
};

export default function InboundShipments() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();

  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showImport, setShowImport] = useState(false);
  const productSkuCache = useRef<Map<string, string | null>>(new Map());

  const refresh = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("inbound_shipments")
      .select(
        "id, shipment_number, status, carrier, tracking_number, dispatched_at, expected_arrival_at, purchase_order_id, created_at, items:inbound_shipment_items(id)",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Failed to load shipments", description: error.message, variant: "destructive" });
      setRows([]);
    } else {
      setRows(
        (data ?? []).map((r: any) => ({
          ...r,
          items_count: Array.isArray(r.items) ? r.items.length : 0,
        })),
      );
    }
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        r.shipment_number.toLowerCase().includes(q) ||
        (r.carrier ?? "").toLowerCase().includes(q) ||
        (r.tracking_number ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, statusFilter]);

  const productResolver: AsnProductResolver = useMemo(
    () => ({
      async resolveBySku(sku: string) {
        const key = sku.trim().toLowerCase();
        if (!key) return null;
        const cached = productSkuCache.current.get(key);
        if (cached !== undefined) return cached;
        const { data } = await supabase
          .from("products")
          .select("id")
          .eq("organization_id", currentOrg!.id)
          .eq("business_id", currentBusiness!.id)
          .ilike("sku", sku.trim())
          .limit(1);
        const id = (data && data[0]?.id) || null;
        productSkuCache.current.set(key, id);
        return id;
      },
    }),
    [currentOrg?.id, currentBusiness?.id],
  );

  const handleBatchImport: BatchImportFn = useCallback(
    async (csvRows) => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        throw new Error("No active organization/business");
      }
      const { data: userRes } = await supabase.auth.getUser();
      const handler = createAsnBatchImportHandler({
        supabase,
        organizationId: currentOrg.id,
        businessId: currentBusiness.id,
        branchId: null,
        createdBy: userRes.user?.id ?? null,
        productResolver,
        resolvePoByNumber: async (poNumber) => {
          const { data } = await supabase
            .from("purchase_orders")
            .select("id")
            .eq("organization_id", currentOrg.id)
            .eq("business_id", currentBusiness.id)
            .eq("po_number", poNumber)
            .limit(1);
          return (data && data[0]?.id) || null;
        },
        defaultStatus: "dispatched",
      });
      const res = await handler(csvRows);
      return res as ImportResults;
    },
    [currentOrg?.id, currentBusiness?.id, productResolver],
  );

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Inbound Shipments</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Advance shipping notices from your suppliers. Import an ASN to prefill Goods Receipt lines with expected quantities, lots and expiry.
            </p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <Button variant="outline" onClick={() => setShowImport(true)}>
              <Upload className="mr-2 h-4 w-4" /> Import ASN
            </Button>
          </div>
        </div>

        <div className="stats-grid grid-cols-2 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{rows.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">In transit</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">
                {rows.filter((r) => r.status === "in_transit" || r.status === "dispatched").length}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Arrived</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{rows.filter((r) => r.status === "arrived").length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Received</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {rows.filter((r) => r.status === "received").length}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search shipment #, carrier, tracking..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="dispatched">Dispatched</SelectItem>
                  <SelectItem value="in_transit">In transit</SelectItem>
                  <SelectItem value="arrived">Arrived</SelectItem>
                  <SelectItem value="received">Received</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <Truck className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm">No inbound shipments yet.</p>
                <p className="text-xs mt-1">Import an ASN CSV to get started.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shipment #</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>Tracking</TableHead>
                    <TableHead>Dispatched</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/inventory-app/inbound-shipments/${r.id}`)}
                    >
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-2">
                          <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" />
                          {r.shipment_number}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[r.status] ?? "secondary"}>
                          {r.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>{r.carrier ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{r.tracking_number ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {r.dispatched_at ? format(new Date(r.dispatched_at), "dd MMM yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.expected_arrival_at ? format(new Date(r.expected_arrival_at), "dd MMM yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-right">{r.items_count ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <ImportWizard
        open={showImport}
        onOpenChange={setShowImport}
        entityName="Inbound Shipment"
        fieldDefinitions={ASN_IMPORT_FIELDS}
        onImport={async () => {}}
        onBatchImport={handleBatchImport}
        onComplete={() => {
          productSkuCache.current.clear();
          void refresh();
        }}
      />
    </>
  );
}
