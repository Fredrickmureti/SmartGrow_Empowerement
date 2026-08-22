/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { BaseCurrencyAmount } from "@/components/finance/BaseCurrencyAmount";
import { useQueryClient } from "@tanstack/react-query";
import { useInvoices, Invoice } from "@/hooks/useInvoices";
import { useAgingReport } from "@/hooks/useAgingReport";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  Search,
  MoreHorizontal,
  CreditCard,
  ChevronDown,
  ChevronRight,
  FileText,
  BookOpen,
  Eye,
  Users,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Banknote,
  Wallet,
  BarChart3,
  History,
} from "lucide-react";
import {
  RecordCustomerPaymentDialog as RecordPaymentDialog,
  RecordCustomerPaymentDialog as SalesRecordPaymentDialog,
} from "@/components/payments/RecordCustomerPaymentDialog";

import { AdvancePaymentDialog } from "@/components/payments/AdvancePaymentDialog";
import { PaymentHistoryDialog } from "@/components/invoices/PaymentHistoryDialog";
import { useQuery } from "@tanstack/react-query";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { ControlAccountReconciliationCard } from "@/components/finance/ControlAccountReconciliationCard";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";

export default function AccountsReceivable() {
  const queryClient = useQueryClient();
  const { invoices, isLoading: invoicesLoading, refreshInvoices } = useInvoices();
  const [rollup, setRollup] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("rollup") === "1";
  });
  const { data: agingData, isLoading: agingLoading, error: agingError } = useAgingReport({ reportType: "ar", rollupToCommercialPartner: rollup });
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });
  const [showAdvanceDialog, setShowAdvanceDialog] = useState(false);
  const [showStandalonePaymentDialog, setShowStandalonePaymentDialog] = useState(false);
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  const isLoading = invoicesLoading || agingLoading;

  // Use aging data for customer-grouped view
  const filteredContacts = useMemo(() => {
    if (!agingData?.contacts) return [];
    let contacts = agingData.contacts;

    if (statusFilter === "overdue") {
      contacts = contacts.filter(c => c.documents.some(d => d.days_overdue > 0));
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      contacts = contacts.filter(
        c =>
          c.contact_name.toLowerCase().includes(q) ||
          (c.company || "").toLowerCase().includes(q) ||
          c.documents.some(d => d.document_number.toLowerCase().includes(q))
      );
    }

    return contacts;
  }, [agingData, statusFilter, searchQuery]);

  const summary = agingData?.summary || { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0, total: 0 };

  const toggleCustomer = (contactId: string) => {
    setExpandedCustomers(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const expandAll = () => {
    if (!agingData?.contacts) return;
    setExpandedCustomers(new Set(agingData.contacts.map(c => c.contact_id)));
  };

  const collapseAll = () => setExpandedCustomers(new Set());

  const handleReceivePayment = (invoiceId: string) => {
    const inv = invoices.find(i => i.id === invoiceId);
    if (inv) {
      setSelectedInvoice(inv);
      setShowPaymentDialog(true);
    }
  };

  const handleViewPaymentHistory = (invoiceId: string) => {
    const inv = invoices.find(i => i.id === invoiceId);
    if (inv) {
      setSelectedInvoice(inv);
      setShowPaymentHistory(true);
    }
  };

  /** Open the document (invoice/migration) in the drawer */
  const handleViewDocument = (sourceId: string, sourceType: string) => {
    setDrawerSource({ type: sourceType, id: sourceId });
    setDrawerOpen(true);
  };

  /** Resolve the posting journal entry from the invoice and open it in the drawer.
   *  If no posting JE exists, surface a clear warning instead of silently
   *  opening the invoice — a missing posting JE on a non-draft invoice means
   *  AR is broken and the accountant must be told. */
  const handleViewPostingJournal = async (invoiceId: string) => {
    const { data, error } = await supabase
      .from("invoices")
      .select("journal_entry_id, status, invoice_number")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error || !data?.journal_entry_id) {
      const isDraft = data?.status === "draft";
      toast.warning(
        isDraft
          ? `Invoice ${data?.invoice_number ?? ""} has no posting journal entry yet (status: draft).`
          : `Invoice ${data?.invoice_number ?? ""} is missing a posting journal entry — AR may be out of sync.`,
      );
      setDrawerSource({ type: "invoice", id: invoiceId });
      setDrawerOpen(true);
      return;
    }
    setDrawerSource({ type: "journal_entry", id: data.journal_entry_id });
    setDrawerOpen(true);
  };

  // Backwards-compat alias for existing call sites
  const handleViewJournalEntry = handleViewDocument;

  const getAgingBadge = (daysOverdue: number) => {
    if (daysOverdue > 90) return <Badge variant="destructive" className="text-xs">90+ days</Badge>;
    if (daysOverdue > 60) return <Badge variant="destructive" className="text-xs opacity-80">60-90 days</Badge>;
    if (daysOverdue > 30) return <Badge className="text-xs bg-amber-500/90 text-white">30-60 days</Badge>;
    if (daysOverdue > 0) return <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">Overdue {daysOverdue}d</Badge>;
    if (daysOverdue < 0) return <Badge variant="secondary" className="text-xs">Not Due</Badge>;
    return <Badge variant="outline" className="text-xs">Due Today</Badge>;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }


  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Accounts Receivable</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Customer balances, outstanding invoices, and payment collection
          </p>
          {/* Phase 2: scope label so users know whether AR totals are for a
              single branch or the consolidated business. */}
          <div className="mt-2"><FinanceScopeBadge /></div>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ['invoices'] as const,
              ['aging-report'] as const,
              ['payments'] as const,
            ]}
            tooltip="Refresh AR data"
          />
          <Button variant="outline" size="sm" onClick={() => navigate("/finance/reports/aging?type=receivable")}>
            <BarChart3 className="h-4 w-4 mr-1" />
            AR Aging Report
          </Button>
        </div>
      </div>

      {/* A failed ageing query must never masquerade as "zero receivables". */}
      {agingError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 inline mr-2" />
          Receivables could not be loaded, so the totals below are not reliable.
          {" "}
          {(agingError as Error).message}
        </div>
      )}

      {/* Summary Cards with Aging - Fluid layout that wraps and shows full values */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Receivable</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-primary tabular-nums whitespace-nowrap">
              {formatCurrency(summary.total)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <Users className="h-3 w-3 inline mr-1" />
              {filteredContacts.length} customer{filteredContacts.length !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-emerald-500">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Not Due</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-emerald-600 tabular-nums whitespace-nowrap">
              {formatCurrency(summary.not_due || 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Not yet due</p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-yellow-400">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">1-30 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-yellow-600 tabular-nums whitespace-nowrap">
              {formatCurrency(summary.current)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-400">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">31-60 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-amber-600 tabular-nums whitespace-nowrap">
              {formatCurrency(summary.days30)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">61-90 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-orange-600 tabular-nums whitespace-nowrap">
              {formatCurrency(summary.days60)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-destructive">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">90+ Days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-destructive tabular-nums whitespace-nowrap">
              {formatCurrency(summary.days90)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sub-ledger ↔ GL control account integrity */}
      <ControlAccountReconciliationCard reportType="ar" />

      {/* Unapplied Credits Banner */}
      <Card className="border-l-4 border-l-primary bg-primary/5">
        <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Wallet className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">Unapplied Customer Credits</p>
              <p className="text-xs text-muted-foreground">Credits available to apply against outstanding invoices</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => navigate("/finance/customer-credits")}>
            <CreditCard className="h-4 w-4 mr-1" />
            Manage Credits
          </Button>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search customer, invoice #..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Outstanding</SelectItem>
              <SelectItem value="overdue">Overdue Only</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={rollup ? "default" : "outline"}
            size="sm"
            onClick={() => {
              const next = !rollup;
              setRollup(next);
              const url = new URL(window.location.href);
              if (next) url.searchParams.set("rollup", "1"); else url.searchParams.delete("rollup");
              window.history.replaceState({}, "", url.toString());
            }}
            title="Roll up sub-contacts into their parent commercial partner"
          >
            <Users className="h-4 w-4 mr-1" />
            {rollup ? "Rolled up" : "Roll up parents"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setShowStandalonePaymentDialog(true)}>
            <CreditCard className="h-4 w-4 mr-1" />
            Receive Payment
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowAdvanceDialog(true)}>
            <Banknote className="h-4 w-4 mr-1" />
            Advance Payment
          </Button>
          <div className="hidden sm:flex gap-2">
            <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
            <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
          </div>
        </div>
      </div>

      {/* Customer-Grouped Table */}
      {filteredContacts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-500" />
            <p className="font-medium">No outstanding receivables</p>
            <p className="text-sm mt-1">All customer invoices are paid!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredContacts.map((contact) => {
            const isExpanded = expandedCustomers.has(contact.contact_id);
            const hasOverdue = contact.documents.some(d => d.days_overdue > 0);

            return (
              <Card key={contact.contact_id} className={hasOverdue ? "border-l-4 border-l-destructive/50" : ""}>
                <Collapsible open={isExpanded} onOpenChange={() => toggleCustomer(contact.contact_id)}>
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors">
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div>
                          <ClickableEntity
                            onClick={() => setPreviewContactId(contact.contact_id)}
                            className="font-semibold text-base"
                          >
                            {contact.contact_name}
                          </ClickableEntity>
                          <div className="text-xs text-muted-foreground">
                            {contact.documents.length} invoice{contact.documents.length !== 1 ? "s" : ""}
                            {contact.company && ` • ${contact.company}`}
                          </div>
                        </div>
                        {hasOverdue && (
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                        )}
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="text-emerald-600">{formatCurrency(contact.buckets.current)}</span>
                          <span className="text-amber-600">{formatCurrency(contact.buckets.days30)}</span>
                          <span className="text-orange-600">{formatCurrency(contact.buckets.days60)}</span>
                          <span className="text-destructive">{formatCurrency(contact.buckets.days90)}</span>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-base">{formatCurrency(contact.buckets.total)}</div>
                        </div>
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t overflow-x-auto">
                      {/* Mobile card view */}
                      <div className="sm:hidden divide-y">
                        {contact.documents.map((doc) => (
                          <div key={doc.id} className="p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <button
                                className="font-mono text-sm font-medium text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                                onClick={(e) => { e.stopPropagation(); handleViewJournalEntry(doc.id, "invoice"); }}
                              >{doc.document_number}</button>
                              <div className="flex items-center gap-2">
                                {doc.source === "migration" && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleViewJournalEntry(doc.id, "migration"); }}
                                    title="View migration journal entry"
                                  >
                                    <Badge variant="outline" className="text-[10px] px-1.5 cursor-pointer hover:bg-accent">Migrated</Badge>
                                  </button>
                                )}
                                {getAgingBadge(doc.days_overdue)}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-7 w-7">
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => handleReceivePayment(doc.id)}>
                                      <CreditCard className="h-4 w-4 mr-2" />
                                      Receive Payment
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => handleViewPaymentHistory(doc.id)}>
                                      <History className="h-4 w-4 mr-2" />
                                      Payment History
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleViewDocument(doc.id, "invoice")}>
                                      <FileText className="h-4 w-4 mr-2" />
                                      View Invoice
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleViewPostingJournal(doc.id)}>
                                      <BookOpen className="h-4 w-4 mr-2" />
                                      View Posting Journal
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </div>
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>{doc.document_date}</span>
                              <span>Due: {doc.due_date}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Balance</span>
                              <span className="font-semibold"><BaseCurrencyAmount value={doc.balance_due} format={formatCurrency} label="Balance" /></span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* Desktop table view */}
                      <Table className="hidden sm:table">
                        <TableHeader>
                          <TableRow className="bg-muted/30">
                            <TableHead className="text-xs">Invoice #</TableHead>
                            <TableHead className="text-xs">Date</TableHead>
                            <TableHead className="text-xs">Due Date</TableHead>
                            <TableHead className="text-xs text-right">Total</TableHead>
                            <TableHead className="text-xs text-right">Paid</TableHead>
                            <TableHead className="text-xs text-right">Balance</TableHead>
                            <TableHead className="text-xs">Aging</TableHead>
                            <TableHead className="w-[50px]" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {contact.documents.map((doc) => (
                            <TableRow key={doc.id}>
                              <TableCell className="font-mono text-sm">
                                <button
                                  className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                                  onClick={() => handleViewJournalEntry(doc.id, "invoice")}
                                >{doc.document_number}</button>
                                {doc.source === "migration" && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleViewJournalEntry(doc.id, "migration"); }}
                                    title="View migration journal entry"
                                  >
                                    <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 cursor-pointer hover:bg-accent">Migrated</Badge>
                                  </button>
                                )}
                              </TableCell>
                              <TableCell className="text-sm">{doc.document_date}</TableCell>
                              <TableCell className="text-sm">{doc.due_date}</TableCell>
                              <TableCell className="text-right text-sm">{formatCurrency(doc.total)}</TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">{formatCurrency(doc.amount_paid)}</TableCell>
                              <TableCell className="text-right font-semibold text-sm"><BaseCurrencyAmount value={doc.balance_due} format={formatCurrency} label="Balance" /></TableCell>
                              <TableCell>{getAgingBadge(doc.days_overdue)}</TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-7 w-7">
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => handleReceivePayment(doc.id)}>
                                      <CreditCard className="h-4 w-4 mr-2" />
                                      Receive Payment
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => handleViewPaymentHistory(doc.id)}>
                                      <History className="h-4 w-4 mr-2" />
                                      Payment History
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleViewDocument(doc.id, "invoice")}>
                                      <FileText className="h-4 w-4 mr-2" />
                                      View Invoice
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleViewPostingJournal(doc.id)}>
                                      <BookOpen className="h-4 w-4 mr-2" />
                                      View Posting Journal
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            );
          })}
        </div>
      )}

      {/* Payment History Dialog */}
      <PaymentHistoryDialog
        invoice={selectedInvoice}
        open={showPaymentHistory}
        onOpenChange={setShowPaymentHistory}
      />

      {/* Record Payment Dialog (per-invoice) */}
      <RecordPaymentDialog
        invoice={selectedInvoice}
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        onSuccess={() => {
          refreshInvoices();
          queryClient.invalidateQueries({ queryKey: ["aging-report"] });
        }}
      />

      {/* Standalone Receive Payment Dialog (customer-first, multi-invoice) */}
      <SalesRecordPaymentDialog
        open={showStandalonePaymentDialog}
        onOpenChange={setShowStandalonePaymentDialog}
        onPaymentRecorded={() => {
          refreshInvoices();
          queryClient.invalidateQueries({ queryKey: ["aging-report"] });
          queryClient.invalidateQueries({ queryKey: ["customer-credits"] });
        }}
      />

      {/* Advance Payment Dialog */}
      <AdvancePaymentDialog
        open={showAdvanceDialog}
        onOpenChange={setShowAdvanceDialog}
        onSuccess={() => {
          refreshInvoices();
          queryClient.invalidateQueries({ queryKey: ["aging-report"] });
          queryClient.invalidateQueries({ queryKey: ["customer-credits"] });
        }}
      />

      {/* Transaction Preview Drawer (replaces ad-hoc JE dialog) */}
      <TransactionPreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sourceType={drawerSource.type}
        sourceId={drawerSource.id}
      />

      {/* Contact Preview Drawer */}
      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />
    </div>
  );
}