import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useRFQs } from "@/hooks/useRFQs";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { usePeekParam } from "@/design-system";
import { RFQPeekSheet } from "@/features/purchases/rfqs/RFQPeekSheet";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Send,
  Eye,
  Award,
  ArrowRightLeft,
  FileText,
  TrendingUp,
  Clock,
  Ban,
  Pencil,
} from "lucide-react";
import { format } from "date-fns";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";

// Compact workflow pipeline for table rows
function RFQPipeline({ status }: { status: string }) {
  const steps = [
    { key: "draft", label: "Draft" },
    { key: "sent", label: "Sent" },
    { key: "received", label: "Received" },
    { key: "closed", label: "Closed" },
  ];

  const getActiveStep = () => {
    if (status === "cancelled") return -1;
    if (status === "draft") return 0;
    if (status === "sent") return 1;
    if (status === "received") return 2;
    if (status === "closed") return 3;
    return 0;
  };

  const activeStep = getActiveStep();

  if (status === "cancelled") {
    return (
      <div className="flex items-center gap-1">
        <Ban className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs text-destructive font-medium">Cancelled</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-0.5">
          <div
            className={`h-2 w-2 rounded-full transition-colors ${
              i <= activeStep
                ? i === activeStep
                  ? "bg-primary ring-2 ring-primary/30"
                  : "bg-primary"
                : "bg-muted-foreground/20"
            }`}
            title={step.label}
          />
          {i < steps.length - 1 && (
            <div className={`h-[1.5px] w-3 ${i < activeStep ? "bg-primary" : "bg-muted-foreground/20"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function RFQs() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { rfqs, isLoading, updateStatus, deleteRFQ } = useRFQs();
  const { contacts } = useContacts();
  const { formatCurrency, baseCurrency } = useCurrency();
  const [peekId, setPeekId] = usePeekParam();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Intercept ?action=create from the GlobalCreateMenu.
  useEffect(() => {
    if (searchParams.get("action") === "create") {
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      setSearchParams(next, { replace: true });
      navigate("/purchases/rfqs/new");
    }
  }, [searchParams, setSearchParams, navigate]);

  const filteredRFQs = rfqs.filter((rfq) => {
    const matchesSearch = rfq.rfq_number.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || rfq.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Compute estimated value per RFQ
  const getRFQEstimatedValue = (rfq: any) => {
    return (rfq.items || []).reduce((sum: number, item: any) => {
      return sum + (item.target_price || 0) * (item.quantity || 1);
    }, 0);
  };

  // Stats
  const stats = {
    total: rfqs.length,
    open: rfqs.filter((r) => ["draft", "sent", "received"].includes(r.status)).length,
    closed: rfqs.filter((r) => r.status === "closed").length,
    totalEstimatedValue: rfqs.reduce((sum, rfq) => sum + getRFQEstimatedValue(rfq), 0),
    conversionRate: rfqs.length > 0
      ? Math.round((rfqs.filter((r) => r.status === "closed").length / rfqs.length) * 100)
      : 0,
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary",
      sent: "default",
      received: "outline",
      closed: "default",
      cancelled: "destructive",
    };
    return <Badge variant={variants[status] || "outline"}>{status}</Badge>;
  };

  const getVendorStatusBadge = (status: string) => {
    switch (status) {
      case "awarded":
        return <Badge variant="default"><Award className="h-3 w-3 mr-1" /> Awarded</Badge>;
      case "quoted":
        return <Badge variant="outline">Quoted</Badge>;
      case "declined":
        return <Badge variant="destructive">Declined</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Requests for Quotation</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Send quote requests to suppliers and compare responses
              </p>
            </div>
            <RefreshButton queryKeyPrefixes={[["rfqs"]]} tooltip="Refresh RFQs" />
          </div>
          <div className="flex items-center gap-2">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "rfq_number", header: "RFQ #", width: 14 },
                  { key: "deadline", header: "Deadline", width: 12 },
                  { key: "status", header: "Status", width: 10 },
                  { key: "vendors", header: "Vendors", width: 20 },
                  { key: "items_count", header: "Items", width: 8 },
                  { key: "estimated_value", header: "Est. Value", width: 14 },
                ];
                return {
                  title: "Requests for Quotation",
                  columns: cols,
                  rows: filteredRFQs.map((rfq: any) => ({
                    rfq_number: rfq.rfq_number,
                    deadline: rfq.deadline ? format(new Date(rfq.deadline), "MMM d, yyyy") : "—",
                    status: rfq.status,
                    vendors: (rfq.vendors || []).map((v: any) => v.vendor?.name).filter(Boolean).join(", "),
                    items_count: (rfq.items || []).length,
                    estimated_value: getRFQEstimatedValue(rfq),
                  })),
                  generatedAt: new Date(),
                } as ExportConfig;
              }}
            />
            <Button onClick={() => { resetForm(); setShowCreateDialog(true); }}>
              <Plus className="mr-2 h-4 w-4" /> Create RFQ
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Total RFQs
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Open
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-amber-600">{stats.open}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                Est. Value
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold">
                {formatCurrency(stats.totalEstimatedValue, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Conversion
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-emerald-600">{stats.conversionRate}%</div>
              <p className="text-xs text-muted-foreground">{stats.closed} converted to PO</p>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search RFQs..."
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
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>RFQ #</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Suppliers</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Est. Value</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">Loading...</TableCell>
                </TableRow>
              ) : filteredRFQs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="h-8 w-8" />
                      <span>No RFQs found</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredRFQs.map((rfq) => {
                  const estValue = getRFQEstimatedValue(rfq);
                  return (
                    <TableRow key={rfq.id}>
                      <TableCell className="font-medium font-mono">{rfq.rfq_number}</TableCell>
                      <TableCell className="text-sm">{format(new Date(rfq.created_at), "MMM d, yyyy")}</TableCell>
                      <TableCell className="text-sm">
                        {rfq.deadline ? format(new Date(rfq.deadline), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell>{rfq.items?.length || 0} items</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {rfq.vendors?.slice(0, 3).map((v: any) => (
                            <Badge key={v.id} variant="outline" className="text-xs">
                              {v.vendor?.name}
                            </Badge>
                          ))}
                          {(rfq.vendors?.length || 0) > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{(rfq.vendors?.length || 0) - 3}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <RFQPipeline status={rfq.status} />
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {estValue > 0 ? formatCurrency(estValue, baseCurrency) : "—"}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setSelectedRFQ(rfq); setShowDetailDialog(true); }}>
                              <Eye className="mr-2 h-4 w-4" /> View Details
                            </DropdownMenuItem>
                            {rfq.status === "draft" && (
                              <DropdownMenuItem onClick={() => updateStatus({ id: rfq.id, status: "sent" })}>
                                <Send className="mr-2 h-4 w-4" /> Mark as Sent
                              </DropdownMenuItem>
                            )}
                            {rfq.status === "sent" && (
                              <DropdownMenuItem onClick={() => updateStatus({ id: rfq.id, status: "received" })}>
                                <FileText className="mr-2 h-4 w-4" /> Mark Responses Received
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {rfq.status === "draft" && (
                              <DropdownMenuItem onClick={() => deleteRFQ(rfq.id)} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create RFQ Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Request for Quotation</DialogTitle>
            <DialogDescription>Select products, quantities, and vendors to request quotes from</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Response Deadline</Label>
                <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." />
              </div>
            </div>

            {/* Line Items */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm sm:text-base font-semibold">Products</Label>
                <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                  <Plus className="mr-1 h-3 w-3" /> Add Item
                </Button>
              </div>
              {lineItems.map((item, index) => (
                <div key={index} className="border rounded-lg p-3 space-y-3 sm:space-y-0 sm:grid sm:grid-cols-12 sm:gap-2 sm:items-end sm:border-0 sm:p-0 sm:rounded-none">
                  <div className="sm:col-span-5">
                    <Label className="text-xs text-muted-foreground sm:hidden mb-1 block">Product</Label>
                    <Select value={item.product_id || ""} onValueChange={(v) => updateLineItem(index, "product_id", v)}>
                      <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                      <SelectContent>
                        {products.filter((p) => p.is_active).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="text-xs text-muted-foreground sm:hidden mb-1 block">Description</Label>
                    <Input placeholder="Description" value={item.description} onChange={(e) => updateLineItem(index, "description", e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:contents">
                    <div className="sm:col-span-2">
                      <Label className="text-xs text-muted-foreground sm:hidden mb-1 block">Quantity</Label>
                      <NumericInput placeholder="Qty" value={item.quantity} onValueChange={(v) => updateLineItem(index, "quantity", v ?? 0)} />
                    </div>
                    <div className="sm:col-span-1">
                      <Label className="text-xs text-muted-foreground sm:hidden mb-1 block">Target Price</Label>
                      <NumericInput placeholder="Target $" value={item.target_price ?? null} onValueChange={(v) => updateLineItem(index, "target_price", v ?? 0)} />
                    </div>
                  </div>
                  <div className="sm:col-span-1 flex justify-end">
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeLineItem(index)} disabled={lineItems.length === 1}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Vendor Selection */}
            <div className="space-y-3">
              <Label className="text-sm sm:text-base font-semibold">Invite Suppliers ({selectedVendorIds.length} selected)</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto border rounded-md p-3">
                {vendors.length === 0 ? (
                  <p className="text-sm text-muted-foreground col-span-full">No suppliers found. Add suppliers in Contacts first.</p>
                ) : (
                  vendors.map((vendor) => (
                    <div key={vendor.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`vendor-${vendor.id}`}
                        checked={selectedVendorIds.includes(vendor.id)}
                        onCheckedChange={() => toggleVendor(vendor.id)}
                      />
                      <label htmlFor={`vendor-${vendor.id}`} className="text-sm cursor-pointer">
                        {vendor.name}
                      </label>
                    </div>
                  ))
                )}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create RFQ"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* RFQ Detail Dialog */}
      <Dialog open={showDetailDialog} onOpenChange={setShowDetailDialog}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {selectedRFQ && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle>{selectedRFQ.rfq_number}</DialogTitle>
                  {getStatusBadge(selectedRFQ.status)}
                </div>
                <DialogDescription>
                  Created {format(new Date(selectedRFQ.created_at), "MMM d, yyyy")}
                  {selectedRFQ.deadline && ` · Deadline: ${format(new Date(selectedRFQ.deadline), "MMM d, yyyy")}`}
                </DialogDescription>
              </DialogHeader>

              {/* Pipeline */}
              <div className="py-1">
                <RFQPipeline status={selectedRFQ.status} />
              </div>

              {selectedRFQ.notes && (
                <p className="text-sm text-muted-foreground">{selectedRFQ.notes}</p>
              )}

              {/* Items */}
              <div>
                <h4 className="text-sm font-semibold mb-2">Requested Items</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Target Price</TableHead>
                      <TableHead className="text-right">Est. Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selectedRFQ.items || []).map((item: any) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.description}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">
                          {item.target_price ? formatCurrency(item.target_price, baseCurrency) : "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {item.target_price
                            ? formatCurrency(item.target_price * item.quantity, baseCurrency)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Vendors */}
              <div>
                <h4 className="text-sm font-semibold mb-2">Invited Suppliers</h4>
                <div className="space-y-2">
                  {(selectedRFQ.vendors || []).map((rfqVendor: any) => (
                    <div key={rfqVendor.id} className="flex items-center justify-between p-3 rounded-lg border">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                          {rfqVendor.vendor?.name?.charAt(0)}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{rfqVendor.vendor?.name}</p>
                          {getVendorStatusBadge(rfqVendor.status)}
                        </div>
                      </div>
                      {selectedRFQ.status === "received" && rfqVendor.status !== "awarded" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleConvertToPO(selectedRFQ, rfqVendor)}
                        >
                          <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                          Convert to PO
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
