import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useReplenishmentLogs } from "@/hooks/useReplenishmentLogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Search, Package, AlertTriangle, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { normalizeError } from "@/services/resilience";

export default function ReplenishmentLog() {
  const navigate = useNavigate();
  const { logs, isLoading, triggerReplenishment } = useReplenishmentLogs();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [isTriggering, setIsTriggering] = useState(false);

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      const result = await triggerReplenishment();
      toast.success(`Replenishment check complete: ${result?.replenishment?.created || 0} POs created`);
    } catch (error: any) {
      toast.error(`Failed: ${normalizeError(error).message}`);
    } finally {
      setIsTriggering(false);
    }
  };

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.product?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.purchase_order?.po_number?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || log.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "po_created":
        return <Badge variant="default"><CheckCircle2 className="h-3 w-3 mr-1" /> PO Created</Badge>;
      case "pending":
        return <Badge variant="secondary">Pending</Badge>;
      case "failed":
        return <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" /> Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const stats = {
    total: logs.length,
    created: logs.filter((l) => l.status === "po_created").length,
    failed: logs.filter((l) => l.status === "failed").length,
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Replenishment</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Auto-generated purchase orders when stock hits reorder levels
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              queryKeyPrefixes={[
                ["replenishment-logs"] as const,
                ["low-stock-products"] as const,
              ]}
              tooltip="Refresh replenishment log"
            />
            <Button onClick={handleTrigger} disabled={isTriggering}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isTriggering ? "animate-spin" : ""}`} />
              {isTriggering ? "Checking..." : "Run Replenishment Check"}
            </Button>
          </div>
        </div>

        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Triggers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">POs Created</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.created}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{stats.failed}</div>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by product or PO number..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="po_created">PO Created</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Triggered</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Stock Level</TableHead>
                <TableHead className="text-right">Qty Ordered</TableHead>
                <TableHead>PO #</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">Loading...</TableCell>
                </TableRow>
              ) : filteredLogs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <Package className="h-8 w-8" />
                      <span>No replenishment activity yet</span>
                      <span className="text-xs">Set up reorder rules with "Auto Create PO" enabled, then run a check</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredLogs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-sm">
                      {format(new Date(log.triggered_at), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell className="font-medium">
                      <button
                        className="text-primary hover:underline text-left"
                        onClick={() => navigate(`/inventory-app/products?selected=${log.product_id}`)}
                      >
                        {log.product?.name || "—"}
                      </button>
                      {log.product?.sku && (
                        <span className="text-xs text-muted-foreground ml-1">({log.product.sku})</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={log.trigger_type === "auto" ? "secondary" : "outline"}>
                        {log.trigger_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{log.current_stock}</TableCell>
                    <TableCell className="text-right">{log.reorder_quantity}</TableCell>
                    <TableCell>
                      {log.purchase_order ? (
                        <button
                          className="text-sm font-medium text-primary hover:underline"
                          onClick={() => navigate(`/purchases?selected=${log.purchase_order_id}`)}
                        >
                          {log.purchase_order.po_number}
                        </button>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {getStatusBadge(log.status)}
                        {log.error_message && (
                          <span className="text-xs text-destructive">{log.error_message}</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
