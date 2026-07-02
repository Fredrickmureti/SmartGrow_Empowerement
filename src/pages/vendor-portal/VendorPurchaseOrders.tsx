/**
 * Vendor Portal - Purchase Orders View with clickable rows, filters, and mobile layout
 */
import { useState } from "react";
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";

const statusColor: Record<string, string> = {
  draft: "secondary",
  sent: "default",
  confirmed: "default",
  received: "default",
  cancelled: "destructive",
};

export default function VendorPurchaseOrders() {
  const { purchaseOrders } = useVendorPortal();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = purchaseOrders.filter((po) => {
    const matchesSearch = po.po_number.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || po.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statuses = [...new Set(purchaseOrders.map((po) => po.status))];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-foreground">Purchase Orders</h2>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by PO number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop Table */}
      <Card className="hidden sm:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Expected Delivery</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No purchase orders found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((po) => (
                  <TableRow
                    key={po.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/vendor-portal/purchase-orders/${po.id}`)}
                  >
                    <TableCell className="font-medium text-primary">{po.po_number}</TableCell>
                    <TableCell>{new Date(po.order_date).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {po.expected_date ? new Date(po.expected_date).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={(statusColor[po.status] as any) || "secondary"}>
                        {po.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {po.currency} {po.total.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile Cards */}
      <div className="sm:hidden space-y-3">
        {filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No purchase orders found.</p>
        ) : (
          filtered.map((po) => (
            <Card
              key={po.id}
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => navigate(`/vendor-portal/purchase-orders/${po.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-primary">{po.po_number}</span>
                  <Badge variant={(statusColor[po.status] as any) || "secondary"} className="text-xs">
                    {po.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{new Date(po.order_date).toLocaleDateString()}</span>
                  <span className="font-medium text-foreground">
                    {po.currency} {po.total.toLocaleString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
