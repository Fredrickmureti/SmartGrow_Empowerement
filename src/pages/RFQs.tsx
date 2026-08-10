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
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

// Compact workflow pipeline for table rows
function RFQPipeline({ status }: { status: string }) {
  const steps = [
    { key: "draft", label: "Draft" },
    { key: "approved", label: "Approved" },
    { key: "sent", label: "Sourcing" },
    { key: "awarded", label: "Awarded" },
    { key: "converted", label: "Converted" },
  ];

  // Sourcing collapses several live states onto one dot: the pipeline shows
  // progress, the status badge shows the exact state.
  const getActiveStep = () => {
    if (status === "cancelled" || status === "expired") return -1;
    if (status === "draft" || status === "pending_approval") return 0;
    if (status === "approved") return 1;
    if (["sent", "responses_received", "under_evaluation"].includes(status)) return 2;
    if (status === "awarded") return 3;
    if (status === "converted" || status === "closed") return 4;
    return 0;
  };

  const activeStep = getActiveStep();

  if (status === "cancelled" || status === "expired") {
    return (
      <div className="flex items-center gap-1">
        <Ban className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs text-destructive font-medium capitalize">{status}</span>
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
  const {
    rfqs,
    isLoading,
    submitForApproval,
    approveRFQ,
    releaseRFQ,
    convertToPurchaseOrders,
    deleteRFQ,
  } = useRFQs();
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
    open: rfqs.filter((r) =>
      ["draft", "pending_approval", "approved", "sent", "responses_received", "under_evaluation"].includes(r.status),
    ).length,
    closed: rfqs.filter((r) => ["converted", "closed"].includes(r.status)).length,
    totalEstimatedValue: rfqs.reduce((sum, rfq) => sum + getRFQEstimatedValue(rfq), 0),
    conversionRate: rfqs.length > 0
      ? Math.round(
          (rfqs.filter((r) => ["converted", "closed"].includes(r.status)).length / rfqs.length) * 100,
        )
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
                    vendors: (rfq.invitations || []).map((v: any) => v.vendor?.name).filter(Boolean).join(", "),
                    items_count: (rfq.items || []).length,
                    estimated_value: getRFQEstimatedValue(rfq),
                  })),
                  generatedAt: new Date(),
                } as ExportConfig;
              }}
            />
            <ScanToDocumentButton createPath="/purchases/rfqs/new" label="Scan to RFQ" />
            <Button onClick={() => navigate("/purchases/rfqs/new")}>
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
              <SelectItem value="pending_approval">Pending approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="sent">Sent to suppliers</SelectItem>
              <SelectItem value="responses_received">Responses received</SelectItem>
              <SelectItem value="under_evaluation">Under evaluation</SelectItem>
              <SelectItem value="awarded">Awarded</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
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
                          {rfq.invitations?.slice(0, 3).map((inv: any) => (
                            <Badge key={inv.id} variant="outline" className="text-xs">
                              {inv.supplier?.name}
                            </Badge>
                          ))}
                          {(rfq.invitations?.length || 0) > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{(rfq.invitations?.length || 0) - 3}
                            </Badge>
                          )}
                          {(rfq.quotations?.length || 0) > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {rfq.quotations?.length} quoted
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
                            <DropdownMenuItem onClick={() => setPeekId(rfq.id)}>
                              <Eye className="mr-2 h-4 w-4" /> Quick view
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/purchases/rfqs/${rfq.id}`)}>
                              <FileText className="mr-2 h-4 w-4" /> Open full page
                            </DropdownMenuItem>
                            {rfq.status === "draft" && (
                              <DropdownMenuItem onClick={() => navigate(`/purchases/rfqs/${rfq.id}/edit`)}>
                                <Pencil className="mr-2 h-4 w-4" /> Edit
                              </DropdownMenuItem>
                            )}
                            {rfq.status === "draft" && (
                              <DropdownMenuItem onClick={() => submitForApproval(rfq.id)}>
                                <Send className="mr-2 h-4 w-4" /> Submit for approval
                              </DropdownMenuItem>
                            )}
                            {rfq.status === "pending_approval" && (
                              <DropdownMenuItem onClick={() => approveRFQ(rfq.id)}>
                                <Award className="mr-2 h-4 w-4" /> Approve
                              </DropdownMenuItem>
                            )}
                            {rfq.status === "approved" && (
                              <DropdownMenuItem onClick={() => releaseRFQ(rfq.id)}>
                                <Send className="mr-2 h-4 w-4" /> Release to suppliers
                              </DropdownMenuItem>
                            )}
                            {rfq.status === "awarded" && (
                              <DropdownMenuItem onClick={() => convertToPurchaseOrders(rfq.id)}>
                                <ArrowRightLeft className="mr-2 h-4 w-4" /> Convert awards to POs
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

      <RFQPeekSheet
        rfqId={peekId}
        onOpenChange={(open) => !open && setPeekId(null)}
      />
    </>
  );
}
