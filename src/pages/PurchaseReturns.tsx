import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { usePurchaseReturns, PurchaseReturnItem, PurchaseReturn } from "@/hooks/usePurchaseReturns";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { usePeekParam } from "@/design-system";
import { PurchaseReturnPeekSheet } from "@/features/purchases/returns/PurchaseReturnPeekSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  CheckCircle,
  XCircle,
  RotateCcw,
  Eye,
  FileText,
  TrendingDown,
  Clock,
  Package,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildPurchasesReturnSnapshot } from "@/services/documents/snapshots/purchasesReturn";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { supabase } from "@/integrations/supabase/client";
import { Printer, Mail, Loader2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { PackagedQtyCell } from "@/components/products/PackagedQtyCell";

// Compact workflow pipeline for table rows
function WorkflowPipeline({ status }: { status: string }) {
  const steps = [
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "processed", label: "Processed" },
  ];

  const getActiveStep = () => {
    if (status === "cancelled") return -1;
    if (status === "pending") return 0;
    if (status === "approved") return 1;
    if (status === "processed") return 2;
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

export default function PurchaseReturns() {
  const { purchaseReturns, isLoading, createPurchaseReturn, updatePurchaseReturn, deletePurchaseReturn, refreshPurchaseReturns } = usePurchaseReturns();
  const navigate = useNavigate();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const [showDialog, setShowDialog] = useState(false);
  const [peekId, setPeekId] = usePeekParam();
  const [selectedReturn, setSelectedReturn] = useState<PurchaseReturn | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isPrinting, setIsPrinting] = useState<string | null>(null);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  const handlePrintReturn = async (pr: PurchaseReturn) => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      toast({ title: "No organization/company", description: "Pick a company before printing.", variant: "destructive" });
      return;
    }
    setIsPrinting(pr.id);
    try {
      const built = await fetchAndBuildPurchasesReturnSnapshot(supabase, pr.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "purchases.return",
        organizationId: currentOrg.id,
        sourceModule: "purchases",
        sourceDocType: "purchase_return",
        sourceDocId: pr.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? currentBranch?.id ?? null,
        partyKind: "supplier",
        partyId: built.vendorId,
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        toast,
        { label: `Return ${pr.return_number}` },
      );
    } catch (err) {
      toast({ title: "Print failed", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setIsPrinting(null);
    }
  };

  const [formData, setFormData] = useState({
    vendor_id: "",
    return_date: new Date().toISOString().split("T")[0],
    reason: "",
    notes: "",
  });

  const [lineItems, setLineItems] = useState<Omit<PurchaseReturnItem, "id" | "purchase_return_id">[]>([
    { product_id: null, description: "", quantity: 1, unit_price: 0, line_total: 0, sort_order: 0 },
  ]);

  const vendors = contacts.filter((c) => (c.type === "supplier" || c.type === "both") && c.is_active);

  const resetForm = () => {
    setFormData({ vendor_id: "", return_date: new Date().toISOString().split("T")[0], reason: "", notes: "" });
    setLineItems([{ product_id: null, description: "", quantity: 1, unit_price: 0, line_total: 0, sort_order: 0 }]);
  };

  const updateLineItem = (index: number, field: string, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };

    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = product.cost_price || product.unit_price;
      }
    }

    updated[index].line_total = updated[index].quantity * updated[index].unit_price;
    setLineItems(updated);
  };

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity: 1, unit_price: 0, line_total: 0, sort_order: lineItems.length }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.vendor_id || !formData.reason || lineItems.every((item) => !item.description)) {
      toast({ title: "Please fill required fields", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      await createPurchaseReturn(
        {
          vendor_id: formData.vendor_id,
          return_date: formData.return_date,
          reason: formData.reason,
          status: "pending",
          total: 0,
          notes: formData.notes || null,
          purchase_order_id: null,
        },
        lineItems.filter((item) => item.description)
      );
      toast({ title: "Purchase return created" });
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast({ title: "Error creating return", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusChange = async (id: string, status: string) => {
    setIsUpdating(true);
    try {
      await updatePurchaseReturn(id, { status: status as any });
      toast({ title: `Status updated to ${status}` });
      // Refresh detail dialog data
      const updated = purchaseReturns.find(p => p.id === id);
      if (updated && selectedReturn?.id === id) {
        setSelectedReturn({ ...updated, status: status as any });
      }
    } catch (error: any) {
      toast({ title: "Error updating status", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePurchaseReturn(id);
      toast({ title: "Purchase return deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting return", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const filteredReturns = purchaseReturns.filter((pr) => {
    const matchesSearch =
      pr.return_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pr.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || pr.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Financial stats
  const stats = {
    total: purchaseReturns.length,
    totalValue: purchaseReturns.reduce((sum, pr) => sum + pr.total, 0),
    pending: purchaseReturns.filter((pr) => pr.status === "pending"),
    approved: purchaseReturns.filter((pr) => pr.status === "approved"),
    processed: purchaseReturns.filter((pr) => pr.status === "processed"),
  };

  const grandTotal = lineItems.reduce((sum, item) => sum + item.line_total, 0);

  return (
    <>
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Purchase Returns</h1>
              <p className="text-sm sm:text-base text-muted-foreground">Manage returns to vendors and track debit notes</p>
            </div>
            <RefreshButton onRefresh={refreshPurchaseReturns} tooltip="Refresh purchase returns" />
          </div>
          <div className="flex items-center gap-2">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "return_number", header: "Return #", width: 14 },
                  { key: "vendor", header: "Vendor", width: 20 },
                  { key: "return_date", header: "Return Date", width: 12 },
                  { key: "reason", header: "Reason", width: 20 },
                  { key: "status", header: "Status", width: 10 },
                  { key: "total", header: "Total", width: 14 },
                ];
                return {
                  title: "Purchase Returns",
                  columns: cols,
                  rows: filteredReturns.map((pr) => ({
                    return_number: pr.return_number,
                    vendor: pr.vendor?.name || "—",
                    return_date: format(new Date(pr.return_date), "MMM d, yyyy"),
                    reason: pr.reason,
                    status: pr.status,
                    total: pr.total,
                  })),
                  generatedAt: new Date(),
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="managePurchases">
              <Button onClick={() => navigate("/purchases/returns/new")} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" /> Create Return
              </Button>
            </PermissionGate>
          </div>
        </div>

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
                {formatCurrency(stats.totalValue, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">{stats.total} returns</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Pending Approval
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-amber-600">
                {stats.pending.length}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(stats.pending.reduce((s, r) => s + r.total, 0), baseCurrency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5" />
                Approved
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-blue-600">
                {stats.approved.length}
              </div>
              <p className="text-xs text-muted-foreground">Stock adjusted</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Processed
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl sm:text-2xl font-bold text-emerald-600">
                {stats.processed.length}
              </div>
              <p className="text-xs text-muted-foreground">Debit notes issued</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search returns..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
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
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {(isLoading || !currencyReady) ? (
              <div className="flex items-center justify-center py-12">
                <RotateCcw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredReturns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <RotateCcw className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No purchase returns yet</h3>
                <p className="text-muted-foreground mb-4">Record returns when you send items back to vendors</p>
                <PermissionGate permission="managePurchases">
                  <Button variant="outline" size="sm" onClick={() => navigate("/purchases/returns/new")}>
                    <Plus className="mr-2 h-4 w-4" /> Create Return
                  </Button>
                </PermissionGate>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Return #</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReturns.map((pr) => (
                    <TableRow
                      key={pr.id}
                      className="cursor-pointer"
                      onClick={() => setPeekId(pr.id)}
                    >
                      <TableCell className="font-medium font-mono">{pr.return_number}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {pr.vendor ? (
                          <ClickableEntity onClick={() => setPreviewContactId(pr.vendor_id)}>
                            {pr.vendor.name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{format(new Date(pr.return_date), "MMM d, yyyy")}</TableCell>
                      <TableCell className="max-w-[150px] truncate text-sm">{pr.reason}</TableCell>
                      <TableCell>
                        <WorkflowPipeline status={pr.status} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          <Package className="h-3 w-3 mr-1" />
                          {pr.items?.length || 0}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium text-destructive">
                        -{formatCurrency(pr.total, baseCurrency)}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setPeekId(pr.id)}>
                              <Eye className="mr-2 h-4 w-4" /> View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handlePrintReturn(pr)} disabled={isPrinting === pr.id}>
                              {isPrinting === pr.id ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                              ) : (
                                <><Printer className="mr-2 h-4 w-4" /> Print</>
                              )}
                            </DropdownMenuItem>
                            {pr.vendor_id && (
                              <DropdownMenuItem onClick={() => {
                                const vendor = contacts.find(c => c.id === pr.vendor_id);
                                setEmailDocument({
                                documentType: "credit_note" as any,
                                  documentId: pr.id,
                                  documentNumber: pr.return_number,
                                  recipientEmail: vendor?.email || "",
                                  recipientName: vendor?.name || "",
                                  total: pr.total,
                                  currency: baseCurrency,
                                });
                                setShowEmailDialog(true);
                              }}>
                                <Mail className="mr-2 h-4 w-4" /> Email to Supplier
                              </DropdownMenuItem>
                            )}
                            {pr.status === "pending" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => {
                                  if (isReadOnly) { openUpgradeModal("purchase_returns"); return; }
                                  handleStatusChange(pr.id, "approved");
                                }}>
                                  <CheckCircle className="mr-2 h-4 w-4" /> Approve
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => {
                                  if (isReadOnly) { openUpgradeModal("purchase_returns"); return; }
                                  handleStatusChange(pr.id, "cancelled");
                                }}>
                                  <XCircle className="mr-2 h-4 w-4" /> Cancel
                                </DropdownMenuItem>
                              </>
                            )}
                            {pr.status === "approved" && (
                              <DropdownMenuItem onClick={() => {
                                if (isReadOnly) { openUpgradeModal("purchase_returns"); return; }
                                handleStatusChange(pr.id, "processed");
                              }}>
                                <FileText className="mr-2 h-4 w-4" /> Process (Debit Note + GL)
                              </DropdownMenuItem>
                            )}
                            {pr.status === "pending" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => {
                                    if (isReadOnly) { openUpgradeModal("purchase_returns"); return; }
                                    handleDelete(pr.id);
                                  }}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>


      {/* Email Dialog */}
      <SendDocumentDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        document={emailDocument}
      />

      {/* Peek Sheet */}
      <PurchaseReturnPeekSheet
        returnId={peekId}
        onOpenChange={(open) => { if (!open) setPeekId(null); }}
      />

    </>

    <ContactPreviewDrawer
      open={!!previewContactId}
      onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
      contactId={previewContactId}
    />
    </>
  );
}
