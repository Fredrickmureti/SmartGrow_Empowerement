import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useProformaInvoices } from "@/hooks/useProformaInvoices";
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

import { SendDocumentDialog, DocumentEmailData } from "@/components/common/SendDocumentDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { Plus, Search, MoreHorizontal, FileText, Send, Loader2, FileCheck, Mail, Printer, Trash2, ExternalLink } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { useBusinesses } from "@/hooks/useBusinesses";
import { fetchAndBuildSalesProformaSnapshot } from "@/services/documents/snapshots/salesProforma";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { normalizeError } from "@/services/resilience";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ProformaPeekSheet } from "@/features/sales/proforma/ProformaPeekSheet";
import { usePeekParam } from "@/design-system/records";
import { ScanToDocumentButton } from "@/components/documents/lines/ScanToDocumentButton";

export default function ProformaInvoices() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [searchParams, setSearchParams] = useSearchParams();
  const { proformaInvoices, isLoading, deleteProformaInvoice, setProformaStatus, convertToInvoice, refresh } = useProformaInvoices();
  const { formatCurrency } = useCurrency();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "proforma_invoice" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters } = useCustomFieldFiltering("proforma_invoice");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailDocument, setEmailDocument] = useState<DocumentEmailData | null>(null);
  const [peekId, setPeekId] = usePeekParam();

  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  // Deep-link: ?id={uuid} opens peek sheet directly
  useEffect(() => {
    const id = searchParams.get("id");
    if (!id) return;
    setPeekId(id);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setPeekId]);


  // Wave 7.2 — print goes straight down the canonical document pipeline
  // (snapshot → document_records → output intent). The preview dialog is
  // kept as an operator-facing fallback surface only; it is no longer the
  // print path, so rapid Sales prints can't get bounced off the raw FIFO
  // hardware route by an ask_user/error branch.
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState("");
  const [printDocumentId, setPrintDocumentId] = useState("");
  const [printCommunication, setPrintCommunication] =
    useState<Parameters<typeof PrintPreviewDialog>[0]["communication"]>(undefined);

  const handleSendEmail = (inv: typeof proformaInvoices[0]) => {
    setEmailDocument({
      documentType: "proforma",
      documentId: inv.id,
      documentNumber: inv.proforma_number,
      recipientEmail: inv.contact?.email || "",
      recipientName: inv.contact?.name || "",
      total: inv.total,
      currency: inv.currency,
    });
    setShowEmailDialog(true);
  };

  const handlePrint = async (inv: typeof proformaInvoices[0]) => {
    if (!currentBusiness?.id) {
      toast({
        title: "No company selected",
        description: "Pick a company before printing proforma invoices.",
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

    try {
      const built = await fetchAndBuildSalesProformaSnapshot(supabase, inv.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.proforma",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "proforma",
        sourceDocId: inv.id,
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
        toast,
        { label: `Proforma ${inv.proforma_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  const filteredInvoices = useMemo(() => proformaInvoices.filter(inv => {
    const matchesSearch = inv.proforma_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || inv.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [proformaInvoices, searchQuery, statusFilter]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allSelected = filteredInvoices.length > 0 && filteredInvoices.every(i => selectedIds.has(i.id));
  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredInvoices.map(i => i.id)));
    }
  }, [allSelected, filteredInvoices]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      await deleteProformaInvoice(id);
    }
    setSelectedIds(new Set());
    toast({ title: `${ids.length} proforma(s) deleted` });
  }, [selectedIds, deleteProformaInvoice, toast]);

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: "bg-muted text-muted-foreground",
      sent: "bg-blue-100 text-blue-800",
      accepted: "bg-green-100 text-green-800",
      rejected: "bg-red-100 text-red-800",
      expired: "bg-orange-100 text-orange-800",
      converted: "bg-purple-100 text-purple-800",
    };
    return <Badge className={styles[status] || "bg-muted"}>{status}</Badge>;
  };

  const stats = {
    total: proformaInvoices.length,
    draft: proformaInvoices.filter(i => i.status === "draft").length,
    sent: proformaInvoices.filter(i => i.status === "sent").length,
    accepted: proformaInvoices.filter(i => i.status === "accepted").length,
    totalValue: proformaInvoices.reduce((sum, i) => sum + i.total, 0),
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">Proforma Invoices</h1>
              {currentOrg && (
                <RefreshButton queryKeyPrefixes={[queryKeys.proformaInvoices.all(currentOrg.id)]} tooltip="Refresh proforma invoices" />
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">Pre-sale invoices and quotations</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "proforma_number", header: "Proforma #", width: 15 },
                  { key: "date", header: "Date", width: 12 },
                  { key: "customer", header: "Customer", width: 25 },
                  { key: "status", header: "Status", width: 12 },
                  { key: "total", header: "Total", format: "currency", width: 14, align: "right" },
                ];
                const rows = filteredInvoices.map((inv) => ({
                  proforma_number: inv.proforma_number,
                  date: inv.issue_date,
                  customer: inv.contact?.name || "",
                  status: inv.status,
                  total: inv.total,
                }));
                return {
                  title: "Proforma Invoices Report",
                  columns: cols,
                  rows,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <ScanToDocumentButton createPath="/sales/proforma/new" label="Scan to proforma" />
              <Button onClick={() => navigate("/sales/proforma/new")} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                New Proforma
              </Button>
            </PermissionGate>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Proformas</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Drafts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-muted-foreground">{stats.draft}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Sent</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{stats.sent}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Accepted</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.accepted}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search proformas..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
            </SelectContent>
          </Select>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (confirm(`Delete ${selectedIds.size} proforma invoice(s)? This cannot be undone.`)) {
                    handleBulkDelete();
                  }
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </div>
          )}
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredInvoices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <FileCheck className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No proforma invoices yet</h3>
                <p className="text-muted-foreground mb-4">Create proformas before converting to final invoices</p>
                <PermissionGate permission="manageSales">
                  <Button onClick={() => navigate("/sales/proforma/new")}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Proforma
                  </Button>
                </PermissionGate>
              </div>
            ) : (
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead>Proforma #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Issue Date</TableHead>
                    <TableHead>Expiry Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv) => (
                    <TableRow key={inv.id} className={`cursor-pointer ${selectedIds.has(inv.id) ? "bg-muted/50" : ""}`} onClick={() => setPeekId(inv.id)}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(inv.id)}
                          onCheckedChange={() => toggleSelect(inv.id)}
                          aria-label={`Select ${inv.proforma_number}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{inv.proforma_number}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {inv.contact?.name ? (
                          <ClickableEntity onClick={() => {
                            setContactDrawerId((inv as any).contact_id);
                            setContactDrawerOpen(true);
                          }}>
                            {inv.contact.name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell>{format(new Date(inv.issue_date), "MMM d, yyyy")}</TableCell>
                      <TableCell>{format(new Date(inv.expiry_date), "MMM d, yyyy")}</TableCell>
                      <TableCell>{getStatusBadge(inv.status)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(inv.total, inv.currency)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handlePrint(inv)}>
                              <Printer className="mr-2 h-4 w-4" />
                              Print Proforma
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate(`/sales/proforma/${inv.id}`)}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              Open Full Page
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <FileText className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSendEmail(inv)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Send via Email
                            </DropdownMenuItem>
                            <PermissionGate permission="manageSales">
                              <DropdownMenuSeparator />
                              {inv.status === "draft" && (
                                <DropdownMenuItem onClick={() => {
                                  if (isReadOnly) { openUpgradeModal("proforma_invoices"); return; }
                                  setProformaStatus(inv.id, "sent");
                                }}>
                                  <Send className="mr-2 h-4 w-4" />
                                  Mark as Sent
                                </DropdownMenuItem>
                              )}
                              {(inv.status === "sent" || inv.status === "accepted") && (
                                <DropdownMenuItem onClick={() => {
                                  if (isReadOnly) { openUpgradeModal("proforma_invoices"); return; }
                                  convertToInvoice(inv.id);
                                }}>
                                  <FileText className="mr-2 h-4 w-4" />
                                  Convert to Invoice
                                </DropdownMenuItem>
                              )}
                              {!["converted", "cancelled"].includes(inv.status) && (
                                <DropdownMenuItem onClick={() => {
                                  if (isReadOnly) { openUpgradeModal("proforma_invoices"); return; }
                                  setProformaStatus(inv.id, "cancelled");
                                }}>
                                  Cancel Proforma
                                </DropdownMenuItem>
                              )}
                              {inv.status !== "converted" && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => {
                                    if (isReadOnly) { openUpgradeModal("proforma_invoices"); return; }
                                    deleteProformaInvoice(inv.id);
                                  }}
                                >
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </PermissionGate>

                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <SendDocumentDialog
          open={showEmailDialog}
          onOpenChange={setShowEmailDialog}
          document={emailDocument}
        />

        <ProformaPeekSheet
          proformaId={peekId}
          onOpenChange={(o) => { if (!o) setPeekId(null); }}
        />


        <PrintPreviewDialog
          open={printPreviewOpen}
          onOpenChange={setPrintPreviewOpen}
          title={printPreviewTitle}
          documentType={printDocumentType}
          documentId={printDocumentId}
          filename={`proforma-${printPreviewTitle.replace('Proforma ', '')}`}
          communication={printCommunication}
        />

        <ContactPreviewDrawer
          open={contactDrawerOpen}
          onOpenChange={setContactDrawerOpen}
          contactId={contactDrawerId}
        />
      </div>
    </>
  );
}
