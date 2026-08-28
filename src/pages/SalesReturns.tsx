import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useSalesReturns } from "@/hooks/useSalesReturns";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useViewMode } from "@/hooks/useViewMode";
import { queryKeys } from "@/lib/queryKeys";
import { useCurrency } from "@/hooks/useCurrency";
import { useContacts } from "@/hooks/useContacts";

import { SalesReturnPeekSheet } from "@/features/sales/returns/SalesReturnPeekSheet";
import { usePeekParam } from "@/design-system/records";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { SummaryStatCard, SummaryStatGrid } from "@/components/common/SummaryStatCards";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Search, MoreHorizontal, CheckCircle, XCircle, Loader2, RotateCcw, Printer, Eye, TrendingDown, CreditCard, ArrowRight, Ban, Mail, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { fetchAndBuildSalesReturnSnapshot } from "@/services/documents/snapshots/salesReturn";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { useCallback } from "react";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { PageHeader, PageBody } from "@/design-system";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

// Workflow step indicator component
function WorkflowPipeline({ status, hasCreditNote, creditNoteStatus }: { status: string; hasCreditNote: boolean; creditNoteStatus?: string }) {
  const steps = [
    { key: "created", label: "Created" },
    { key: "approved", label: "Approved" },
    { key: "cn_issued", label: "CN Issued" },
    { key: "resolved", label: "Resolved" },
  ];

  const getActiveStep = () => {
    if (status === "rejected") return -1; // special case
    if (status === "pending") return 0;
    if (status === "approved" && (!hasCreditNote || creditNoteStatus === "draft")) return 1;
    if (hasCreditNote && creditNoteStatus === "issued") return 2;
    if (hasCreditNote && creditNoteStatus === "applied") return 3;
    if (status === "processed" || status === "refunded") return 3;
    return 1;
  };

  const activeStep = getActiveStep();

  if (status === "rejected") {
    return (
      <div className="flex items-center gap-1">
        <Ban className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs text-destructive font-medium">Rejected</span>
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

export default function SalesReturns() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast: shadcnToast } = useToast();
  const { salesReturns, isLoading, deleteSalesReturn, approveReturn, rejectReturn } = useSalesReturns();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { contacts } = useContacts();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle] = useState("");
  const [printDocumentType] = useState("");
  const [printDocumentId] = useState("");
  const [printCommunication] =
    useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);

  const handlePrint = useCallback(async (ret: { id: string; return_number: string }) => {
    if (!currentBusiness?.id || !currentOrg?.id) {
      shadcnToast({
        title: "Cannot print",
        description: "Pick an organization and company before printing.",
        variant: "destructive",
      });
      return;
    }
    try {
      const built = await fetchAndBuildSalesReturnSnapshot(supabase, ret.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.return",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "sales_return",
        sourceDocId: ret.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? null,
        partyKind: "customer",
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        shadcnToast,
        { label: `Sales return ${ret.return_number}` },
      );
    } catch (err) {
      shadcnToast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  }, [currentBusiness?.id, currentOrg?.id, shadcnToast]);

  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "sales_return" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters } = useCustomFieldFiltering("sales_return");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [detailReturnId, setDetailReturnId] = usePeekParam();

  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  // Deep-link: ?action=create → redirect to create route; ?id={uuid} opens peek sheet
  useEffect(() => {
    const action = searchParams.get("action");
    const invoiceId = searchParams.get("invoice_id");
    const contactId = searchParams.get("contact_id");
    const id = searchParams.get("id");

    if (action === "create") {
      const qs = new URLSearchParams();
      if (invoiceId) qs.set("invoice_id", invoiceId);
      if (contactId) qs.set("contact_id", contactId);
      navigate(`/sales/returns/new${qs.toString() ? `?${qs}` : ""}`, { replace: true });
      return;
    }

    if (!id) return;
    setDetailReturnId(id);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setDetailReturnId, navigate]);


  const filteredReturns = salesReturns.filter(ret => {
    const matchesSearch =
      ret.return_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ret.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || ret.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Financial stats
  const stats = {
    total: salesReturns.length,
    pending: salesReturns.filter(r => r.status === "pending").length,
    totalValue: salesReturns.reduce((sum, r) => sum + r.total, 0),
    creditsGenerated: salesReturns
      .filter(r => r.credit_note)
      .reduce((sum, r) => sum + (r.credit_note?.total || 0), 0),
    creditsApplied: salesReturns
      .filter(r => r.credit_note)
      .reduce((sum, r) => sum + (r.credit_note?.amount_applied || 0) + (r.credit_note?.refund_amount || 0), 0),
    creditsOutstanding: salesReturns
      .filter(r => r.credit_note && (r.credit_note.status === "issued"))
      .reduce((sum, r) => {
        const cn = r.credit_note!;
        return sum + (cn.total - cn.amount_applied - (cn.refund_amount || 0));
      }, 0),
  };

  const getCreditResolutionBadge = (ret: typeof salesReturns[0]) => {
    if (!ret.credit_note) return null;
    const cn = ret.credit_note;
    const available = cn.total - cn.amount_applied - (cn.refund_amount || 0);

    if (cn.status === "draft") return <Badge variant="secondary" className="text-[10px] px-1.5">Draft</Badge>;
    if (cn.status === "applied" || available <= 0.01)
      return <Badge className="bg-emerald-600 text-white text-[10px] px-1.5">Resolved</Badge>;
    if (cn.amount_applied > 0 || (cn.refund_amount || 0) > 0)
      return <Badge className="bg-amber-500 text-white text-[10px] px-1.5">Partial</Badge>;
    return <Badge variant="default" className="text-[10px] px-1.5">Open</Badge>;
  };

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title={
          <span className="flex items-center gap-2">
            Sales Returns
            {currentOrg && (
              <RefreshButton queryKeyPrefixes={[queryKeys.salesReturns.all(currentOrg.id)]} tooltip="Refresh sales returns" />
            )}
          </span>
        }
        description="Manage product returns and track credit note resolution"
        actions={
          <>
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "return_number", header: "Return #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 22 },
                  { key: "reason", header: "Reason", width: 18 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "amount", header: "Amount", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredReturns.map((r) => ({
                  return_number: r.return_number,
                  date: r.return_date,
                  customer: contacts.find(c => c.id === r.contact_id)?.name || "",
                  reason: r.reason || "",
                  status: r.status,
                  amount: r.total,
                }));
                return {
                  title: "Sales Returns Report",
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <ScanToDocumentButton createPath="/sales/returns/new" label="Scan to return" />
              <Button onClick={() => navigate("/sales/returns/new")}>
                <Plus className="mr-2 h-4 w-4" />
                New Return
              </Button>
            </PermissionGate>
          </>
        }
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">


        <SalesReturnPeekSheet salesReturnId={detailReturnId} onOpenChange={(o) => { if (!o) setDetailReturnId(null); }} />

        {/* Financial Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <TrendingDown className="h-3.5 w-3.5" />
                Total Return Value
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-destructive">
                {formatCurrency(stats.totalValue)}
              </div>
              <p className="text-xs text-muted-foreground">{stats.total} returns</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5" />
                Credits Generated
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold">
                {formatCurrency(stats.creditsGenerated)}
              </div>
              <p className="text-xs text-muted-foreground">{salesReturns.filter(r => r.credit_note).length} credit notes</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <ArrowRight className="h-3.5 w-3.5" />
                Credits Used
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-emerald-600">
                {formatCurrency(stats.creditsApplied)}
              </div>
              <p className="text-xs text-muted-foreground">Applied or refunded</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" />
                Outstanding Credits
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-primary">
                {formatCurrency(stats.creditsOutstanding)}
              </div>
              <p className="text-xs text-muted-foreground">{stats.pending} pending approval</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search returns..."
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
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="processed">Processed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredReturns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <RotateCcw className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No sales returns yet</h3>
                <p className="text-muted-foreground mb-4">Record returns when customers send items back</p>
                <Button onClick={() => navigate("/sales/returns/new")}>
                  <Plus className="mr-2 h-4 w-4" />
                  New Return
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Return #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Credit Note</TableHead>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Return Value</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReturns.map((ret) => {
                    const cnAvailable = ret.credit_note
                      ? ret.credit_note.total - ret.credit_note.amount_applied - (ret.credit_note.refund_amount || 0)
                      : null;

                    return (
                      <TableRow key={ret.id} className="cursor-pointer" onClick={() => setDetailReturnId(ret.id)}>
                        <TableCell className="font-medium font-mono">
                          <div className="flex items-center gap-2">
                            <span>{ret.return_number}</span>
                            {ret.wms_return_order_id && (
                              <Badge variant="outline" className="font-sans text-[10px] font-normal">
                                Warehouse
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {ret.contact_id && ret.contact?.name ? (
                            <ClickableEntity onClick={() => setPreviewContactId(ret.contact_id)}>
                              {ret.contact.name}
                            </ClickableEntity>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-sm">{format(new Date(ret.return_date), "MMM d, yyyy")}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {ret.invoice ? (
                            <ClickableEntity onClick={() => navigate(`/sales/invoices?id=${ret.invoice_id}`)}>
                              <div className="space-y-0.5">
                                <span className="font-mono text-xs">{ret.invoice.invoice_number}</span>
                                <div className="text-[10px] text-muted-foreground">
                                  Bal: {formatCurrency((ret.invoice.total || 0) - (ret.invoice.amount_paid || 0))}
                                </div>
                              </div>
                            </ClickableEntity>
                          ) : "—"}
                        </TableCell>
                        <TableCell>
                          {ret.credit_note ? (
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">{ret.credit_note.credit_note_number}</span>
                              {getCreditResolutionBadge(ret)}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <WorkflowPipeline
                            status={ret.status}
                            hasCreditNote={!!ret.credit_note}
                            creditNoteStatus={ret.credit_note?.status}
                          />
                        </TableCell>
                        <TableCell className="max-w-[120px] truncate text-sm">{ret.reason}</TableCell>
                        <TableCell className="text-right font-medium text-destructive">
                          -{formatCurrency(ret.total, ret.currency)}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {cnAvailable !== null && cnAvailable > 0.01 ? (
                            <span className="font-medium text-primary">{formatCurrency(cnAvailable)}</span>
                          ) : cnAvailable !== null ? (
                            <span className="text-muted-foreground text-xs">Settled</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setDetailReturnId(ret.id)}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => navigate(`/sales/returns/${ret.id}`)}>
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Open Full Page
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { void handlePrint(ret); }}>
                                <Printer className="mr-2 h-4 w-4" />
                                Print A4
                              </DropdownMenuItem>
                              {/* Wave 21 — RMA / return sticker.
                                * Routes through the canonical label
                                * dispatcher (ADR-0086 / ADR-0090) so the
                                * physical return tag reuses the same
                                * printer profile, media geometry and
                                * audit trail as every other label. */}
                              <DropdownMenuItem asChild>
                                <PrintLabelButton
                                  variant="ghost"
                                  size="sm"
                                  className="w-full justify-start font-normal px-2 h-8"
                                  label="Print Return Tag"
                                  templateKey="return_label"
                                  workflow="shipping"
                                  product={{
                                    id: ret.id,
                                    name: ret.contact?.name || "Sales Return",
                                    sku: ret.return_number,
                                    barcode: ret.return_number,
                                  }}
                                  sourceDocType="sales_return"
                                  sourceDocId={ret.id}
                                  extraVars={{
                                    return_number: ret.return_number,
                                    customer_name: ret.contact?.name ?? "",
                                    return_date: ret.return_date ?? "",
                                  }}
                                />
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => {
                                const contact = contacts.find(c => c.id === ret.contact_id);
                                setEmailDocument({
                                  documentType: "sales_return",
                                  documentId: ret.id,
                                  documentNumber: ret.return_number,
                                  recipientEmail: contact?.email || "",
                                  recipientName: ret.contact?.name || "",
                                  total: ret.total,
                                  currency: ret.currency || baseCurrency,
                                });
                                setShowEmailDialog(true);
                              }}>
                                <Mail className="mr-2 h-4 w-4" />
                                Email Return
                              </DropdownMenuItem>
                              {ret.status === "pending" && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => {
                                    if (isReadOnly) { openUpgradeModal("sales_returns"); return; }
                                    approveReturn(ret.id);
                                  }}>
                                    <CheckCircle className="mr-2 h-4 w-4" />
                                    Approve & Create Credit Note
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => {
                                    if (isReadOnly) { openUpgradeModal("sales_returns"); return; }
                                    rejectReturn(ret.id);
                                  }}>
                                    <XCircle className="mr-2 h-4 w-4" />
                                    Reject
                                  </DropdownMenuItem>
                                </>
                              )}
                              {ret.status === "pending" && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => {
                                      if (isReadOnly) { openUpgradeModal("sales_returns"); return; }
                                      deleteSalesReturn(ret.id);
                                    }}
                                  >
                                    Delete
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <PrintPreviewDialog
          open={printPreviewOpen}
          onOpenChange={setPrintPreviewOpen}
          title={printPreviewTitle}
          documentType={printDocumentType}
          documentId={printDocumentId}
          communication={printCommunication}
        />
        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
        />

        <ContactPreviewDrawer
          open={!!previewContactId}
          onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
          contactId={previewContactId || undefined}
        />
      </PageBody>
    </>
  );
}
