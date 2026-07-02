/**
 * Vendor Portal - RFQ List View with clickable rows, filters, deadline warnings
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
import { Search, AlertTriangle, Clock } from "lucide-react";

export default function VendorRFQs() {
  const { rfqs } = useVendorPortal();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = rfqs.filter((rfq) => {
    const matchesSearch = rfq.rfq_number.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || rfq.vendor_status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const isDeadlineSoon = (deadline: string | null) => {
    if (!deadline) return false;
    const diff = new Date(deadline).getTime() - Date.now();
    return diff > 0 && diff < 48 * 60 * 60 * 1000;
  };

  const isDeadlinePassed = (deadline: string | null) => {
    if (!deadline) return false;
    return new Date(deadline) < new Date();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-foreground">Requests for Quotation</h2>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by RFQ number..."
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
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="quoted">Quoted</SelectItem>
            <SelectItem value="accepted">Accepted</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Desktop Table */}
      <Card className="hidden sm:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>RFQ #</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead>RFQ Status</TableHead>
                <TableHead>Your Status</TableHead>
                <TableHead className="text-right">Your Quote</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No RFQ requests found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((rfq) => (
                  <TableRow
                    key={rfq.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/vendor-portal/rfqs/${rfq.id}`)}
                  >
                    <TableCell className="font-medium text-primary">{rfq.rfq_number}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {rfq.deadline ? new Date(rfq.deadline).toLocaleDateString() : "—"}
                        {isDeadlineSoon(rfq.deadline) && (
                          <Clock className="h-4 w-4 text-orange-500" />
                        )}
                        {isDeadlinePassed(rfq.deadline) && (
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{rfq.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={rfq.vendor_status === "pending" ? "destructive" : "default"}>
                        {rfq.vendor_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {rfq.quoted_total != null ? rfq.quoted_total.toLocaleString() : "—"}
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
          <p className="text-center text-muted-foreground py-8">No RFQ requests found.</p>
        ) : (
          filtered.map((rfq) => (
            <Card
              key={rfq.id}
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => navigate(`/vendor-portal/rfqs/${rfq.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-primary">{rfq.rfq_number}</span>
                  <Badge variant={rfq.vendor_status === "pending" ? "destructive" : "default"} className="text-xs">
                    {rfq.vendor_status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    {rfq.deadline ? new Date(rfq.deadline).toLocaleDateString() : "No deadline"}
                    {isDeadlineSoon(rfq.deadline) && <Clock className="h-3 w-3 text-orange-500" />}
                    {isDeadlinePassed(rfq.deadline) && <AlertTriangle className="h-3 w-3 text-destructive" />}
                  </div>
                  <span className="font-medium text-foreground">
                    {rfq.quoted_total != null ? rfq.quoted_total.toLocaleString() : "—"}
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
