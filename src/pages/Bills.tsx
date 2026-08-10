import { useState, useRef, useEffect, useMemo } from "react";
import { BILL_IMPORT_FIELDS } from "@/lib/importConfigs/billImportConfig";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useBills, Bill } from "@/hooks/useBills";
import { useContacts } from "@/hooks/useContacts";


import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useExport } from "@/hooks/useExport";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";

import { useBranches } from "@/hooks/useBranches";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildPurchasesBillSnapshot } from "@/services/documents/snapshots/purchasesBill";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  CreditCard,
  Download,
  Upload,
  AlertCircle,
  Eye,
  Loader2,
  Pencil,
  Printer,
  Mail,
  Ban,
  History,
  RotateCcw,
  Send,
  ThumbsUp,
  Undo2,
  BookCheck,
} from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver, ProductResolver } from "@/lib/entityResolver";
import { format, isWithinInterval, parseISO, startOfMonth, endOfMonth } from "date-fns";

import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { usePermissions } from "@/hooks/usePermissions";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { BillPeekSheet } from "@/features/purchases/bills/BillPeekSheet";
import { usePeekParam } from "@/design-system";
// EditBillDialog retired — editing is now the RecordShell route at
// /purchases/bills/:id/edit. See src/features/purchases/bills/BillEditPage.tsx.
import { RecordBillPaymentDialog } from "@/components/bills/RecordBillPaymentDialog";
import { BillPaymentHistoryDialog } from "@/components/bills/BillPaymentHistoryDialog";
import { VoidBillDialog } from "@/components/bills/VoidBillDialog";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";
import { useApSummary } from "@/hooks/useApSummary";


// Workflow pipeline for Bills.
// Mirrors the DB lifecycle: draft → submitted → approved → received (posted)
// → partial → paid. `submitted`/`approved` are pre-GL review states.
function BillWorkflowPipeline({ status }: { status: string }) {
  const steps = [
    { key: "draft", label: "Draft" },
    { key: "submitted", label: "Submitted" },
    { key: "approved", label: "Approved" },
    { key: "received", label: "Posted" },
    { key: "partial", label: "Partial" },
    { key: "paid", label: "Paid" },
  ];

  const getActiveStep = () => {
    if (status === "void") return -1;
    if (status === "draft") return 0;
    if (status === "submitted") return 1;
    if (status === "approved") return 2;
    if (status === "received" || status === "overdue") return 3;
    if (status === "partial") return 4;
    if (status === "paid") return 5;
    return 0;
  };

  const activeStep = getActiveStep();

  if (status === "void") {
    return (
      <div className="flex items-center gap-1">
        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs text-destructive font-medium">Void</span>
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
                  ? status === "overdue"
                    ? "bg-destructive ring-2 ring-destructive/30"
                    : "bg-primary ring-2 ring-primary/30"
                  : "bg-primary"
                : "bg-muted-foreground/20"
            }`}
            title={step.label + (status === "overdue" && i === activeStep ? " (Overdue)" : "")}
          />
          {i < steps.length - 1 && (
            <div className={`h-[1.5px] w-3 ${i < activeStep ? "bg-primary" : "bg-muted-foreground/20"}`} />
          )}
        </div>
      ))}
      {status === "overdue" && (
        <span className="text-[10px] text-destructive font-medium ml-1">Overdue</span>
      )}
    </div>
  );
}

export default function Bills() {
  const [searchParams, setSearchParams] = useSearchParams();
  // View mode state
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "bill" });
  
  // Core field display overrides from Studio
  const coreFieldDisplay = useCoreFieldDisplay("bill");

  // Default list columns - can be overridden by saved list views in Studio
  const defaultBillColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "bill_number", label: "Bill #", visible: true },
    { field: "supplier", label: "Supplier", visible: true },
    { field: "bill_date", label: "Bill Date", visible: true },
    { field: "due_date", label: "Due Date", visible: true },
    { field: "pipeline", label: "Pipeline", visible: true },
    { field: "amount", label: "Amount", visible: true },
    { field: "balance", label: "Balance", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("bill", defaultBillColumns);

  // Custom field filtering
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("bill");

  const {
    bills,
    isLoading,
    requireBillApproval,
    getNextBillNumber,
    createBill,
    confirmBill,
    submitBillForApproval,
    approveBill,
    rejectBill,
    updateBill,
    deleteBill,
    recordBillPayment,
    getDefaultDueDate,
    refreshBills,
  } = useBills();
  // Canonical AP figures (posted documents net of allocations/credits).
  const { summary: apSummary, refresh: refreshApSummary } = useApSummary();
  const navigate = useNavigate();
  const { contacts } = useContacts();

  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { toast } = useToast();
  const { exportBills } = useExport();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { canManagePurchases, canManageFinancials } = usePermissions();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();

  // Check if user is admin/owner
  const userRole = currentOrg?.role;
  const isAdmin = userRole === "owner" || userRole === "admin" || userRole === "super_admin";

  // Print & Email support — routed through the Wave 7.2 canonical
  // pipeline (snapshot → ensureDocumentRecord → printDocumentIntent).
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [isPrinting, setIsPrinting] = useState<string | null>(null);

  // Create/edit flow lives on /purchases/bills/new + /:id/edit (RecordFormShell).
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [selectedBillForPayment, setSelectedBillForPayment] = useState<Bill | null>(null);
  const [peekId, setPeekId] = usePeekParam();
  const [showBillPaymentHistory, setShowBillPaymentHistory] = useState(false);
  const [selectedBillForHistory, setSelectedBillForHistory] = useState<Bill | null>(null);
  const [showVoidBillSheet, setShowVoidBillSheet] = useState(false);
  const [selectedBillForVoid, setSelectedBillForVoid] = useState<Bill | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const urlStatus = new URLSearchParams(window.location.search).get("status");
    return urlStatus || "all";
  });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  // isSubmitting removed with the inline create dialog.
  const [showImportWizard, setShowImportWizard] = useState(false);
  const contactResolverRef = useRef<ContactResolver | null>(null);
  const productResolverRef = useRef<ProductResolver | null>(null);
  
  // Multi-select state
  const [selectedBills, setSelectedBills] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const handlePrintBill = async (bill: Bill) => {
    if (!currentBusiness?.id) {
      toast({
        title: "No company selected",
        description: "Pick a company before printing bills.",
        variant: "destructive",
      });
      return;
    }
    if (!currentOrg?.id) {
      toast({
        title: "No organization",
        description: "Sign in to an organization before printing.",
        variant: "destructive",
      });
      return;
    }
    setIsPrinting(bill.id);
    try {
      // Wave 7.2 — canonical print pipeline: build snapshot → ensure
      // document record → submit routing intent. No direct hardware calls.
      const built = await fetchAndBuildPurchasesBillSnapshot(supabase, bill.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "purchases.bill",
        organizationId: currentOrg.id,
        sourceModule: "purchases",
        sourceDocType: "bill",
        sourceDocId: bill.id,
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
        { label: `Bill ${bill.bill_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsPrinting(null);
    }
  };

  /**
   * Bill void is an intent decision, not a menu click: open the reversal sheet
   * so the server's intent policy and consequence preview run before anyone
   * confirms. `useBills.voidBill` stays only for programmatic callers.
   */
  const handleVoidBill = (bill: Bill) => {
    setSelectedBillForVoid(bill);
    setShowVoidBillSheet(true);
  };


  // Handle deep-link URL params — legacy ?id=<billId> is migrated to
  // the canonical ?peek=<billId> the moment the page mounts, so both
  // legacy shortcuts and freshly-shared links resolve to the same peek
  // surface (usePeekParam handles the storage side).
  useEffect(() => {
    let cancelled = false;

    const consumeParams = (keys: string[]) => {
      const next = new URLSearchParams(searchParams);
      let changed = false;
      keys.forEach((key) => {
        if (next.has(key)) {
          next.delete(key);
          changed = true;
        }
      });
      if (changed) {
        setSearchParams(next, { replace: true });
      }
    };

    const handleDeepLinks = async () => {
      if (searchParams.get("action") === "create") {
        const prefillContactId = searchParams.get("contact_id");
        const q = new URLSearchParams();
        if (prefillContactId) q.set("contact_id", prefillContactId);
        const qs = q.toString();
        navigate(`/purchases/bills/new${qs ? `?${qs}` : ""}`, { replace: true });
        return;
      }


      const legacyBillId = searchParams.get("id");
      if (legacyBillId) {
        if (!cancelled) setPeekId(legacyBillId);
        consumeParams(["id"]);
        return;
      }

      const paymentId = searchParams.get("payment");
      if (!paymentId) return;

      const { data: alloc, error } = await supabase
        .from("bill_payment_allocations")
        .select("bill_id")
        .eq("bill_payment_id", paymentId)
        .limit(1)
        .maybeSingle();

      if (cancelled || error || !alloc?.bill_id) return;
      setPeekId(alloc.bill_id);
      consumeParams(["payment"]);
    };

    void handleDeepLinks();

    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, setPeekId, navigate]);


  const billFieldDefinitions = BILL_IMPORT_FIELDS;

  const handleImportBill = async (row: Record<string, any>) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!currentBusiness) throw new Error("No company selected. Pick a company before importing.");

    if (!contactResolverRef.current) {
      contactResolverRef.current = new ContactResolver(currentOrg.id, currentBusiness.id, "supplier", contacts.filter(c => c.type === "supplier" || c.type === "both"));
    }

    const resolved = await contactResolverRef.current.resolve(row.vendor_name);
    const vendorId = resolved.id;

    const quantity = Number(row.quantity) || 1;
    const unitPrice = Number(row.unit_price) || 0;
    const taxRate = Number(row.tax_rate) || 0;
    const lineTotal = quantity * unitPrice;
    const taxAmount = lineTotal * (taxRate / 100);

    const billNumber = await getNextBillNumber();
    const billDate = row.bill_date || new Date().toISOString().split("T")[0];

    await createBill(
      {
        bill_number: billNumber,
        vendor_id: vendorId,
        vendor_invoice_number: row.vendor_invoice_number || null,
        account_id: null,
        status: "received",
        bill_date: billDate,
        due_date: row.due_date || getDefaultDueDate(billDate),
        subtotal: 0,
        tax_amount: 0,
        discount_amount: 0,
        total: 0,
        amount_paid: 0,
        currency: baseCurrency,
        notes: row.notes || null,
        attachment_url: null,
      },
      [
        {
          account_id: null,
          product_id: null,
          description: row.item_description,
          quantity,
          unit_price: unitPrice,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          line_total: lineTotal,
          sort_order: 0,
        },
      ]
    );
  };

  const handleImportComplete = () => {
    contactResolverRef.current = null;
    productResolverRef.current = null;
  };

  // formData / lineItems / handleSubmit / calculateLineTotal / addLineItem /
  // updateLineItem / removeLineItem removed — the create flow is now the
  // full-page RecordFormShell at /purchases/bills/new.



  // handleRecordPayment removed — using shared RecordBillPaymentDialog

  const openPaymentDialog = (billId: string) => {
    const bill = bills.find((b) => b.id === billId);
    if (bill) {
      setSelectedBillForPayment(bill);
      setShowPaymentDialog(true);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBill(id);
      setSelectedBills((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Bill deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting bill", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  // Bulk delete handler
  const handleBulkDelete = async () => {
    if (selectedBills.size === 0) return;
    
    setIsBulkDeleting(true);
    let successCount = 0;
    let errorCount = 0;

    for (const billId of selectedBills) {
      try {
        await deleteBill(billId);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete bill ${billId}:`, error);
        errorCount++;
      }
    }

    setSelectedBills(new Set());
    setShowBulkDeleteDialog(false);
    setIsBulkDeleting(false);

    if (successCount > 0) {
      toast({ title: `${successCount} bill(s) deleted successfully` });
    }
    if (errorCount > 0) {
      toast({ 
        title: `Failed to delete ${errorCount} bill(s)`, 
        variant: "destructive" 
      });
    }
  };

  // Selection helpers
  const toggleSelectAll = () => {
    if (selectedBills.size === filteredBills.length) {
      setSelectedBills(new Set());
    } else {
      setSelectedBills(new Set(filteredBills.map((b) => b.id)));
    }
  };

  const toggleSelectBill = (billId: string) => {
    setSelectedBills((prev) => {
      const next = new Set(prev);
      if (next.has(billId)) {
        next.delete(billId);
      } else {
        next.add(billId);
      }
      return next;
    });
  };

  // Export selected bills
  const handleExportSelected = () => {
    const billsToExport = selectedBills.size > 0 
      ? bills.filter((b) => selectedBills.has(b.id))
      : bills;
    exportBills(billsToExport);
  };

  const filteredBills = bills.filter((bill) => {
    const matchesSearch =
      bill.bill_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      bill.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || bill.status === statusFilter;
    let matchesDate = true;
    if (dateFrom) {
      matchesDate = matchesDate && bill.bill_date >= dateFrom;
    }
    if (dateTo) {
      matchesDate = matchesDate && bill.bill_date <= dateTo;
    }
    return matchesSearch && matchesStatus && matchesDate;
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary",
      submitted: "outline",
      approved: "outline",
      received: "default",
      partial: "outline",
      paid: "default",
      overdue: "destructive",
      void: "secondary",
    };
    const colors: Record<string, string> = { paid: "bg-green-500", overdue: "bg-red-500" };
    const labels: Record<string, string> = { submitted: "awaiting approval", received: "posted" };
    return <Badge variant={variants[status]} className={colors[status]}>{labels[status] ?? status}</Badge>;
  };

  // Document-count totals stay client-side (they describe the filtered list).
  // Money figures come from `get_ap_summary` — the canonical AP projection —
  // so credit notes, vendor advances and multi-currency are reflected and
  // pre-posting states (draft/submitted/approved) are excluded.
  const totals = {
    total: filteredBills.reduce((sum, b) => sum + b.total, 0),
    outstanding: apSummary.totalOutstanding,
    overdue: apSummary.totalOverdue,
  };

  const pendingApprovalCount = filteredBills.filter(
    (b) => b.status === "submitted" || b.status === "approved"
  ).length;

  const handleSubmitForApproval = async (id: string) => {
    try {
      await submitBillForApproval(id);
      await Promise.all([refreshBills(), refreshApSummary()]);
    } catch {
      /* toast already surfaced by the hook */
    }
  };

  const handleApproveBill = async (id: string) => {
    try {
      await approveBill(id);
      await Promise.all([refreshBills(), refreshApSummary()]);
    } catch {
      /* toast already surfaced by the hook */
    }
  };

  const handleRejectBill = async (id: string) => {
    const reason = window.prompt("Reason for rejecting this bill?");
    if (!reason?.trim()) return;
    try {
      await rejectBill(id, reason);
      await Promise.all([refreshBills(), refreshApSummary()]);
    } catch {
      /* toast already surfaced by the hook */
    }
  };

  const handlePostBill = async (id: string) => {
    try {
      await confirmBill(id);
      await Promise.all([refreshBills(), refreshApSummary()]);
    } catch {
      /* toast already surfaced by the hook */
    }
  };




  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Bills</h1>
              <p className="text-sm sm:text-base text-muted-foreground">Track bills from your suppliers</p>
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                queryKeys.bills.all(currentOrg?.id || ""),
                queryKeys.reports.aging(currentOrg?.id || ""),
              ]}
              tooltip="Refresh bills"
            />
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="bill" />
            <StudioQuickPanelTrigger entityType="bill" />
            <ViewSwitcher
              entityType="bill"
              currentView={currentView}
              onViewChange={setView}
            />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const billData = selectedBills.size > 0
                  ? bills.filter((b) => selectedBills.has(b.id))
                  : bills;
                const cols: ExportColumn[] = [
                  { key: "bill_number", header: "Bill #", width: 14 },
                  { key: "date", header: "Bill Date", width: 12 },
                  { key: "due_date", header: "Due Date", width: 12 },
                  { key: "vendor", header: "Vendor", width: 20 },
                  { key: "status", header: "Status", width: 10 },
                  { key: "subtotal", header: "Subtotal", format: "currency", width: 14, align: "right" },
                  { key: "tax", header: "Tax", format: "currency", width: 12, align: "right" },
                  { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
                  { key: "paid", header: "Paid", format: "currency", width: 14, align: "right" },
                  { key: "balance", header: "Balance", format: "currency", width: 14, align: "right" },
                ];
                const rows = billData.map((b) => ({
                  bill_number: b.bill_number,
                  date: b.bill_date,
                  due_date: b.due_date,
                  vendor: b.vendor?.name || "",
                  status: b.status,
                  subtotal: b.subtotal,
                  tax: b.tax_amount || 0,
                  total: b.total,
                  paid: b.amount_paid || 0,
                  balance: b.total - (b.amount_paid || 0),
                }));
                return {
                  title: "Bills Report",
                  companyName: currentOrg?.name,
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                  organizationId: currentOrg?.id,
                } as ExportConfig;
              }}
            />
            {(canManagePurchases || canManageFinancials) && (
              <>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" /> Import
                </Button>
                <ScanToDocumentButton createPath="/purchases/bills/new" label="Scan to bill" />
                <Button onClick={() => navigate("/purchases/bills/new")} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" /> Add Bill
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Bulk Actions Bar - Admin Only */}
        {isAdmin && selectedBills.size > 0 && (
          <div className="flex items-center justify-between bg-muted/50 border rounded-lg p-3">
            <span className="text-sm font-medium">
              {selectedBills.size} bill{selectedBills.size > 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedBills(new Set())}
              >
                Clear Selection
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowBulkDeleteDialog(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected
              </Button>
            </div>
          </div>
        )}

        <div className="stats-grid grid-cols-2 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Bills</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(totals.total, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{filteredBills.length} bills</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {requireBillApproval ? "In approval" : "Draft"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-muted-foreground">
                {requireBillApproval
                  ? pendingApprovalCount
                  : filteredBills.filter(b => b.status === "draft").length}
              </div>
              <p className="text-xs text-muted-foreground">
                {requireBillApproval
                  ? "Submitted or approved — not yet posted, no GL impact"
                  : "Awaiting confirmation — no GL impact"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-600">{formatCurrency(totals.outstanding, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">
                {apSummary.openDocumentCount} open AP documents
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <AlertCircle className="h-4 w-4 text-destructive" /> Overdue
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{formatCurrency(totals.overdue, baseCurrency)}</div>
              <p className="text-xs text-muted-foreground">{apSummary.overdueCount} past due</p>
            </CardContent>
          </Card>
        </div>

        <div className="filter-bar flex-wrap">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search bills..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="submitted">Awaiting approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="received">Posted</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            placeholder="From"
            className="w-full sm:w-[150px]"
          />
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            placeholder="To"
            className="w-full sm:w-[150px]"
          />
          {(dateFrom || dateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>
              Clear dates
            </Button>
          )}
        </div>

        <CustomFieldFilters entityType="bill" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        {/* Dynamic Views */}
        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={filteredBills as unknown as Record<string, unknown>[]}
        />

        {currentView === "list" && <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {isAdmin && (
                  <TableHead className="w-[50px]">
                    <Checkbox
                      checked={filteredBills.length > 0 && selectedBills.size === filteredBills.length}
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                )}
                <TableHead>Bill #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Bill Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(isLoading || !currencyReady) ? (
                <TableRow><TableCell colSpan={isAdmin ? 10 : 9} className="text-center py-8">Loading...</TableCell></TableRow>
              ) : filteredBills.length === 0 ? (
                <TableRow><TableCell colSpan={isAdmin ? 10 : 9} className="text-center py-8 text-muted-foreground">No bills found</TableCell></TableRow>
              ) : (
                filteredBills.map((bill) => (
                  <TableRow key={bill.id} className={`cursor-pointer ${selectedBills.has(bill.id) ? "bg-muted/50" : ""}`} onClick={() => setPeekId(bill.id)}>
                    {isAdmin && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedBills.has(bill.id)}
                          onCheckedChange={() => toggleSelectBill(bill.id)}
                          aria-label={`Select ${bill.bill_number}`}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">{bill.bill_number}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {bill.vendor ? (
                        <ClickableEntity onClick={() => setPreviewContactId(bill.vendor_id)}>
                          {bill.vendor.name}
                        </ClickableEntity>
                      ) : "—"}
                    </TableCell>
                    <TableCell>{format(new Date(bill.bill_date), "MMM d, yyyy")}</TableCell>
                    <TableCell>{format(new Date(bill.due_date), "MMM d, yyyy")}</TableCell>
                    <TableCell><BillWorkflowPipeline status={bill.status} /></TableCell>
                    <TableCell className="text-right">{formatCurrency(bill.total, bill.currency)}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(bill.total - (bill.amount_paid || 0), bill.currency)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setPeekId(bill.id)}>
                            <Eye className="mr-2 h-4 w-4" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handlePrintBill(bill)}
                            disabled={isPrinting === bill.id}
                          >
                            {isPrinting === bill.id ? (
                              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                            ) : (
                              <><Printer className="mr-2 h-4 w-4" /> Print / Preview</>
                            )}
                          </DropdownMenuItem>
                          {bill.vendor_id && (
                            <DropdownMenuItem onClick={() => {
                              const vendor = contacts.find(c => c.id === bill.vendor_id);
                              setEmailDocument({
                                documentType: "bill",
                                documentId: bill.id,
                                documentNumber: bill.bill_number,
                                recipientEmail: vendor?.email || "",
                                recipientName: vendor?.name || "",
                                total: bill.total,
                                currency: bill.currency,
                              });
                              setShowEmailDialog(true);
                            }}>
                              <Mail className="mr-2 h-4 w-4" /> Email
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {/* Approval lifecycle — pre-GL states only */}
                          {requireBillApproval && bill.status === "draft" && (
                            <DropdownMenuItem onClick={() => handleSubmitForApproval(bill.id)}>
                              <Send className="mr-2 h-4 w-4" /> Submit for Approval
                            </DropdownMenuItem>
                          )}
                          {bill.status === "submitted" && (
                            <>
                              <DropdownMenuItem onClick={() => handleApproveBill(bill.id)}>
                                <ThumbsUp className="mr-2 h-4 w-4" /> Approve
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleRejectBill(bill.id)} className="text-destructive">
                                <Undo2 className="mr-2 h-4 w-4" /> Reject (return to draft)
                              </DropdownMenuItem>
                            </>
                          )}
                          {bill.status === "approved" && (
                            <>
                              <DropdownMenuItem onClick={() => handlePostBill(bill.id)}>
                                <BookCheck className="mr-2 h-4 w-4" /> Post to Ledger
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleRejectBill(bill.id)} className="text-destructive">
                                <Undo2 className="mr-2 h-4 w-4" /> Reject (return to draft)
                              </DropdownMenuItem>
                            </>
                          )}
                          {!requireBillApproval && bill.status === "draft" && (
                            <DropdownMenuItem onClick={() => handlePostBill(bill.id)}>
                              <BookCheck className="mr-2 h-4 w-4" /> Post to Ledger
                            </DropdownMenuItem>
                          )}
                          {(bill.status === "draft" || bill.status === "submitted") && (
                            <DropdownMenuItem onClick={() => {
                              navigate(`/purchases/bills/${bill.id}/edit`);
                            }}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                          )}
                          {/* Payment is only legal once the bill is posted to the ledger. */}
                          {(bill.status === "received" || bill.status === "partial" || bill.status === "overdue") && (
                            <DropdownMenuItem onClick={() => openPaymentDialog(bill.id)}>
                              <CreditCard className="mr-2 h-4 w-4" /> Record Payment
                            </DropdownMenuItem>
                          )}
                          {(bill.amount_paid || 0) > 0 && (
                            <DropdownMenuItem onClick={() => {
                              setSelectedBillForHistory(bill);
                              setShowBillPaymentHistory(true);
                            }}>
                              <History className="mr-2 h-4 w-4" /> Payment History
                            </DropdownMenuItem>
                          )}
                          {(bill.status === "received" || bill.status === "partial") && (
                            <>
                            <DropdownMenuItem onClick={() => handleVoidBill(bill)} className="text-destructive">
                              <Ban className="mr-2 h-4 w-4" /> Void Bill
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => {
                              window.location.href = `/purchases/returns?action=create&contact_id=${bill.vendor_id || ""}`;
                            }}>
                              <RotateCcw className="mr-2 h-4 w-4" /> Create Purchase Return
                            </DropdownMenuItem>
                            </>
                          )}
                          {isAdmin && bill.status === "draft" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleDelete(bill.id)} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>}
      </div>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedBills.size} Bill{selectedBills.size > 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected bills regardless of their status (including overdue, received, partial, or paid). 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isBulkDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                `Delete ${selectedBills.size} Bill${selectedBills.size > 1 ? "s" : ""}`
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bill reversal — intent policy + consequence preview, then void_bill_atomic. */}
      <VoidBillDialog
        bill={selectedBillForVoid}
        open={showVoidBillSheet}
        onOpenChange={setShowVoidBillSheet}
      />

      {/* Bill Payment History Dialog */}
      <BillPaymentHistoryDialog
        bill={selectedBillForHistory}
        open={showBillPaymentHistory}
        onOpenChange={setShowBillPaymentHistory}
      />

      {/* Create/edit bill lives on /purchases/bills/new + /:id/edit (RecordFormShell). */}



      {/* Record Payment Dialog — shared component */}
      <RecordBillPaymentDialog
        bill={selectedBillForPayment}
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        onSuccess={() => {
          setSelectedBillForPayment(null);
        }}
      />

      <BillPeekSheet
        billId={peekId}
        onOpenChange={(open) => { if (!open) setPeekId(null); }}
      />

      {/* Email Dialog */}
      <SendDocumentDialog
        open={showEmailDialog}
        onOpenChange={setShowEmailDialog}
        document={emailDocument}
      />

      {/* Import Wizard */}
      <ImportWizard
        open={showImportWizard}
        onOpenChange={setShowImportWizard}
        entityName="Bill"
        fieldDefinitions={billFieldDefinitions}
        onImport={handleImportBill}
        onComplete={handleImportComplete}
      />

      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />
    </>
  );
}
