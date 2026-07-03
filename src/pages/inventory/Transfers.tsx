/**
 * Stock Transfers — list + new-transfer dialog. Reuses the existing
 * `useWarehouses().createStockTransfer` mutation and `StockTransferPeekSheet`.
 * Honors `?action=new&product=<id>` for deep-link prefill from the product
 * form's "Transfer" CTA.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBranches } from "@/hooks/useBranches";
import { StockTransferPeekSheet } from "@/components/inventory/StockTransferPeekSheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ArrowLeftRight, Plus, Loader2, CheckCircle, XCircle, Clock, Truck,
} from "lucide-react";
import { format } from "date-fns";
import { RefreshButton } from "@/components/ui/RefreshButton";

export default function Transfers() {
  const { transfers, isLoading, approveTransfer, completeTransfer, cancelTransfer } = useWarehouses();
  const { currentBranch } = useBranches();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [drawerId, setDrawerId] = useState<string | null>(null);

  // Deep-link forwarder — legacy `?action=new&product=<id>` now routes to
  // the dedicated create surface, preserving the product prefill.
  useEffect(() => {
    if (searchParams.get("action") !== "new") return;
    const productId = searchParams.get("product");
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    next.delete("product");
    setSearchParams(next, { replace: true });
    navigate(
      productId
        ? `/inventory-app/transfers/new?product=${productId}`
        : "/inventory-app/transfers/new",
      { replace: true },
    );
  }, [searchParams, setSearchParams, navigate]);

  const statusBadge = (s: string) => {
    switch (s) {
      case "draft": return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Draft</Badge>;
      case "approved":
      case "in_transit": return <Badge className="bg-blue-100 text-blue-800"><Truck className="h-3 w-3 mr-1" />In transit</Badge>;
      case "completed": return <Badge className="bg-green-100 text-green-800"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case "cancelled": return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Cancelled</Badge>;
      default: return <Badge variant="outline">{s}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" /> Stock Transfers
          </h1>
          <p className="text-sm text-muted-foreground">
            Move stock between warehouses. Dispatch parks goods in the in-transit
            location until the destination confirms receipt — valuation stays
            truthful while goods are in motion.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ["stock-transfers"] as const,
              ["warehouses"] as const,
              ["warehouse-stock-detail"] as const,
              ["stock-levels-paginated"] as const,
            ]}
            tooltip="Refresh transfers"
          />
          <Button onClick={() => navigate("/inventory-app/transfers/new")}>
            <Plus className="h-4 w-4 mr-1" /> New Transfer
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All transfers</CardTitle>
          <CardDescription>
            {currentBranch ? `Touching branch: ${currentBranch.name}` : "All branches"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : transfers.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No transfers yet. Click <strong>New Transfer</strong> to move stock
              between warehouses.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((t: any) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => setDrawerId(t.id)}
                  >
                    <TableCell className="font-mono text-xs">{t.transfer_number}</TableCell>
                    <TableCell className="text-xs">
                      {t.transfer_date ? format(new Date(t.transfer_date), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.from_warehouse?.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.to_warehouse?.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs">{t.items?.length ?? 0}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex gap-1">
                        {t.status === "draft" && (
                          <Button size="sm" variant="outline" onClick={() => approveTransfer(t.id)}>
                            Dispatch
                          </Button>
                        )}
                        {(t.status === "approved" || t.status === "in_transit") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              completeTransfer(
                                t.id,
                                (t.items || []).map((it: any) => ({
                                  id: it.id,
                                  quantity_received: Number(it.quantity_sent ?? it.quantity_requested) || 0,
                                }))
                              )
                            }
                          >
                            Receive
                          </Button>
                        )}
                        {(t.status === "draft" || t.status === "approved") && (
                          <Button size="sm" variant="ghost" onClick={() => cancelTransfer(t.id)}>
                            <XCircle className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <StockTransferPeekSheet
        open={!!drawerId}
        onOpenChange={(o) => { if (!o) setDrawerId(null); }}
        transferId={drawerId}
      />
    </div>
  );
}
