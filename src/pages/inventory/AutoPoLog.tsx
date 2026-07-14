/**
 * Auto-PO log — archival view of the legacy per-reorder-rule auto-PO
 * executor. Kept separate from the Inventory Planning workspace so the
 * planner UI stays focused on the recommendation lifecycle. New rows here
 * only appear when a `product_reorder_rules` row has `auto_create_po`
 * enabled and the executor produces or fails a PO.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { useReplenishmentLogs } from "@/hooks/useReplenishmentLogs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Search,
  Package,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";

function statusBadge(status: string) {
  switch (status) {
    case "po_created":
      return (
        <Badge variant="default">
          <CheckCircle2 className="h-3 w-3 mr-1" /> PO Created
        </Badge>
      );
    case "pending":
      return <Badge variant="secondary">Pending</Badge>;
    case "failed":
      return (
        <Badge variant="destructive">
          <AlertTriangle className="h-3 w-3 mr-1" /> Failed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function AutoPoLog() {
  const navigate = useNavigate();
  const { logs, isLoading } = useReplenishmentLogs();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const filtered = logs.filter((log) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      log.product?.name?.toLowerCase().includes(q) ||
      log.purchase_order?.po_number?.toLowerCase().includes(q);
    const matchesStatus = status === "all" || log.status === status;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/inventory-app/replenishment")}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Planning
            </Button>
          </div>
          <h1 className="page-title">Auto-PO log</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Archival record of the legacy per-rule auto-PO executor. New rows only
            appear for reorder rules with "Auto create PO" enabled.
          </p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by product or PO number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 w-full"
            aria-label="Search auto-PO log"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter by log status">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
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
                <TableCell colSpan={7} className="text-center py-8">
                  Loading...
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Package className="h-8 w-8" />
                    <span>No auto-PO activity yet.</span>
                    <span className="text-xs">
                      Legacy: rows appear here only for reorder rules with "Auto Create PO" enabled.
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-sm">
                    {format(new Date(log.triggered_at), "MMM d, yyyy HH:mm")}
                  </TableCell>
                  <TableCell className="font-medium">
                    <button
                      className="text-primary hover:underline text-left"
                      onClick={() =>
                        navigate(`/inventory-app/products?selected=${log.product_id}`)
                      }
                    >
                      {log.product?.name || "—"}
                    </button>
                    {log.product?.sku && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({log.product.sku})
                      </span>
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
                        onClick={() =>
                          navigate(`/purchases?selected=${log.purchase_order_id}`)
                        }
                      >
                        {log.purchase_order.po_number}
                      </button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {statusBadge(log.status)}
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
  );
}