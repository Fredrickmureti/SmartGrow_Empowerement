/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { BaseCurrencyAmount } from "@/components/finance/BaseCurrencyAmount";
import { useQueryClient } from "@tanstack/react-query";
import { Bill, useBills } from "@/hooks/useBills";
import { useAgingReport } from "@/hooks/useAgingReport";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAuth } from "@/contexts/AuthContext";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { useToast } from "@/hooks/use-toast";
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
  BookOpen,
  Users,
  AlertTriangle,
  CheckCircle2,
  FileText,
  RefreshCw,
  BarChart3,
  History,
  Eye,
} from "lucide-react";
import { RecordBillPaymentDialog } from "@/components/bills/RecordBillPaymentDialog";
import { BillPaymentHistoryDialog } from "@/components/bills/BillPaymentHistoryDialog";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { ControlAccountReconciliationCard } from "@/components/finance/ControlAccountReconciliationCard";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import type { Database } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

type BillInsert = Database["public"]["Tables"]["bills"]["Insert"];

interface UnlinkedAPExpense {
  id: string;
  description: string;
  amount: number;
  tax_amount: number;
  expense_date: string;
  vendor_id: string | null;
  vendor_name: string | null;
  reference: string | null;
  currency: string;
}

/** Row shape of the AP-expense probe below; pinned via `.returns<>()`. */
interface APExpenseRow {
  id: string;
  description: string;
  amount: number;
  tax_amount: number | null;
  expense_date: string;
  vendor_id: string | null;
  reference: string | null;
  currency: string | null;
  vendor: { name: string | null } | null;
}

/** Identity on the select string — keeps it out of the type-level parser. */
const sel = (s: string): string => s;


export default function AccountsPayable() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { bills, isLoading: billsLoading, refreshBills } = useBills();
  const [rollup, setRollup] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("rollup") === "1";
  });
  const { data: agingData, isLoading: agingLoading } = useAgingReport({ reportType: "ap", rollupToCommercialPartner: rollup });
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranch();
  const { currentBusiness } = useBusinesses();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const { user } = useAuth();
  const { defaultPaymentTerm } = usePaymentTerms();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });
  const [unlinkedExpenses, setUnlinkedExpenses] = useState<UnlinkedAPExpense[]>([]);
  const [creatingBillFor, setCreatingBillFor] = useState<string | null>(null);
  const [showBillPaymentHistory, setShowBillPaymentHistory] = useState(false);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  const isLoading = billsLoading || agingLoading;

  // Fix 5: Detect AP expenses without linked bills
  useEffect(() => {
    const fetchUnlinkedAPExpenses = async () => {
      if (!currentOrg?.id || !currentBusiness?.id || !defaultAccounts.accounts_payable_id) return;

      // Find expenses that credit AP but have no corresponding bill.
      // `sel()` keeps the embedded-select string out of the type-level parser
      // (see query-builder-type-performance) and `.returns<T>()` pins the shape.
      const { data: apExpenses } = await supabase
        .from("expenses")
        .select(sel("id, description, amount, tax_amount, expense_date, vendor_id, reference, currency, vendor:contacts(name)"))
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("payment_account_id", defaultAccounts.accounts_payable_id)
        .returns<APExpenseRow[]>();

      if (!apExpenses || apExpenses.length === 0) {
        setUnlinkedExpenses([]);
        return;
      }

      // Check which have linked bills
      const expenseIds = apExpenses.map(e => e.id);
      const { data: linkedBills } = await supabase
        .from("bills")
        .select("source_expense_id")
        .in("source_expense_id", expenseIds);

      const linkedIds = new Set((linkedBills || []).map(b => b.source_expense_id));
      const unlinked = apExpenses
        .filter(e => !linkedIds.has(e.id))
        .map(e => ({
          id: e.id,
          description: e.description,
          amount: e.amount,
          tax_amount: e.tax_amount || 0,
          expense_date: e.expense_date,
          vendor_id: e.vendor_id,
          vendor_name: (e.vendor as any)?.name || null,
          reference: e.reference,
          currency: e.currency || currentBusiness?.base_currency || "—", // architecture-allow: display-only fallback
        }));

      setUnlinkedExpenses(unlinked);
    };

    fetchUnlinkedAPExpenses();
  }, [currentOrg?.id, currentBusiness?.id, defaultAccounts.accounts_payable_id, bills]);

  const handleCreateBillForExpense = async (expense: UnlinkedAPExpense) => {
    if (!currentOrg || !currentBusiness || !user) return;
    setCreatingBillFor(expense.id);

    try {
      const { data: billNumber, error: numError } = await supabase.rpc("get_next_bill_number", {
        _org_id: currentOrg.id,
        _business_id: currentBusiness.id,
        _branch_id: currentBranch?.id ?? null,
      } as any);
      if (numError) throw numError;

      const billDate = expense.expense_date;
      const dueDate = (() => {
        const date = new Date(billDate);
        const days = defaultPaymentTerm?.days || 30;
        date.setDate(date.getDate() + days);
        return date.toISOString().split("T")[0];
      })();

      const subtotal = expense.amount - expense.tax_amount;

      const billInsert: BillInsert = {
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        // Stage 3: stamp the active branch on the bill so per-branch AP
        // reporting attributes the expense correctly.
        branch_id: currentBranch?.id ?? null,
        created_by: user.id,
        bill_number: billNumber,
        vendor_id: expense.vendor_id,
        bill_date: billDate,
        due_date: dueDate,
        subtotal,
        tax_amount: expense.tax_amount,
        total: expense.amount,
        amount_paid: 0,
        status: "received",
        currency: expense.currency,
        notes: `Created from unlinked AP expense: ${expense.description}`,
        vendor_invoice_number: expense.reference,
        source_expense_id: expense.id,
      } as BillInsert;

      const { error: billError } = await supabase
        .from("bills")
        .insert(billInsert)
        .select()
        .single();

      if (billError) throw billError;

      toast({ title: "Vendor bill created", description: `Bill ${billNumber} created for "${expense.description}"` });
      refreshBills();
      queryClient.invalidateQueries({ queryKey: ["aging-report"] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      // Remove from unlinked list
      setUnlinkedExpenses(prev => prev.filter(e => e.id !== expense.id));
    } catch (err: any) {
      toast({ title: "Failed to create bill", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setCreatingBillFor(null);
    }
  };

  const handleCreateAllMissingBills = async () => {
    for (const expense of unlinkedExpenses) {
      await handleCreateBillForExpense(expense);
    }
  };

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

  const toggleVendor = (contactId: string) => {
    setExpandedVendors(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const expandAll = () => {
    if (!agingData?.contacts) return;
    setExpandedVendors(new Set(agingData.contacts.map(c => c.contact_id)));
  };

  const collapseAll = () => setExpandedVendors(new Set());

  const handlePayBill = (billId: string) => {
    const bill = bills.find(b => b.id === billId);
    if (bill) {
      setSelectedBill(bill);
      setShowPaymentDialog(true);
    }
  };

  const handleViewBillPaymentHistory = (billId: string) => {
    const bill = bills.find(b => b.id === billId);
    if (bill) {
      setSelectedBill(bill);
      setShowBillPaymentHistory(true);
    }
  };

  /** Open the document (bill/migration) in the drawer */
  const handleViewDocument = (sourceId: string, sourceType: string) => {
    setDrawerSource({ type: sourceType, id: sourceId });
    setDrawerOpen(true);
  };

  /** Resolve the posting journal entry from the bill and open it in the drawer.
   *  If no posting JE exists, surface a clear warning instead of silently
   *  opening the bill — a missing posting JE on a non-draft bill means AP
   *  is broken and the accountant must be told. */
  const handleViewPostingJournal = async (billId: string) => {
    const { data, error } = await supabase
      .from("bills")
      .select("journal_entry_id, status, bill_number")
      .eq("id", billId)
      .maybeSingle();
    if (error || !data?.journal_entry_id) {
      const isDraft = data?.status === "draft";
      toast({
        title: isDraft ? "No posting journal entry yet" : "AP integrity warning",
        description: isDraft
          ? `Bill ${data?.bill_number ?? ""} is still a draft and has not been posted.`
          : `Bill ${data?.bill_number ?? ""} is missing a posting journal entry — AP may be out of sync.`,
        variant: isDraft ? "default" : "destructive",
      });
      setDrawerSource({ type: "bill", id: billId });
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
          <h1 className="page-title">Accounts Payable</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Vendor balances, outstanding bills, and payment management
          </p>
          {/* Phase 3: scope label so AP totals are unambiguous (single
              branch vs consolidated business). */}
          <div className="mt-2"><FinanceScopeBadge /></div>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            queryKeyPrefixes={[
              ['bills'] as const,
              ['aging-report'] as const,
              ['payments'] as const,
            ]}
            tooltip="Refresh AP data"
          />
          <Button variant="outline" size="sm" onClick={() => navigate("/finance/reports/aging?type=payable")}>
            <BarChart3 className="h-4 w-4 mr-1" />
            AP Aging Report
          </Button>
        </div>
      </div>

      {/* Sub-ledger ↔ GL control account integrity */}
      <ControlAccountReconciliationCard reportType="ap" />

      {/* Unlinked AP Expenses Warning Banner */}
      {unlinkedExpenses.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-800 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              {unlinkedExpenses.length} AP Expense{unlinkedExpenses.length > 1 ? "s" : ""} Without Vendor Bills
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
              These expenses credit Accounts Payable but have no linked vendor bill. They won't appear in aging reports until a bill is created.
            </p>
            <div className="space-y-2">
              {unlinkedExpenses.map((expense) => (
                <div key={expense.id} className="flex items-center justify-between rounded-md border border-amber-200 dark:border-amber-800 bg-background p-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{expense.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {expense.vendor_name || "No supplier"} • {expense.expense_date} • {formatCurrency(expense.amount)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCreateBillForExpense(expense)}
                    disabled={creatingBillFor === expense.id}
                    className="ml-3 shrink-0"
                  >
                    {creatingBillFor === expense.id ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <FileText className="h-3 w-3 mr-1" />
                    )}
                    Create Bill
                  </Button>
                </div>
              ))}
            </div>
            {unlinkedExpenses.length > 1 && (
              <Button
                size="sm"
                variant="default"
                onClick={handleCreateAllMissingBills}
                className="mt-3"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Create All Missing Bills
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Summary Cards with Aging */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Payable</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="stat-value text-primary tabular-nums whitespace-nowrap">
              {formatCurrency(summary.total)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              <Users className="h-3 w-3 inline mr-1" />
              {filteredContacts.length} vendor{filteredContacts.length !== 1 ? "s" : ""}
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

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search vendor, bill #..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
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
            {rollup ? "Rolled up" : "Roll up parents"}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
          <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
        </div>
      </div>

      {/* Vendor-Grouped Table */}
      {filteredContacts.length === 0 && unlinkedExpenses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-500" />
            <p className="font-medium">No outstanding payables</p>
            <p className="text-sm mt-1">All vendor bills are paid!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredContacts.map((contact) => {
            const isExpanded = expandedVendors.has(contact.contact_id);
            const hasOverdue = contact.documents.some(d => d.days_overdue > 0);

            return (
              <Card key={contact.contact_id} className={hasOverdue ? "border-l-4 border-l-destructive/50" : ""}>
                <Collapsible open={isExpanded} onOpenChange={() => toggleVendor(contact.contact_id)}>
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
                            {contact.documents.length} bill{contact.documents.length !== 1 ? "s" : ""}
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
                    <div className="border-t">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/30">
                            <TableHead className="text-xs">Bill #</TableHead>
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
                                  onClick={() => handleViewJournalEntry(doc.id, "bill")}
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
                                    <DropdownMenuItem onClick={() => handlePayBill(doc.id)}>
                                       <CreditCard className="h-4 w-4 mr-2" />
                                       Pay Bill
                                     </DropdownMenuItem>
                                     <DropdownMenuSeparator />
                                     <DropdownMenuItem onClick={() => handleViewBillPaymentHistory(doc.id)}>
                                       <History className="h-4 w-4 mr-2" />
                                       Payment History
                                     </DropdownMenuItem>
                                     <DropdownMenuItem onClick={() => navigate(`/purchases/bills?highlight=${doc.id}`)}>
                                       <FileText className="h-4 w-4 mr-2" />
                                       View in Bills
                                     </DropdownMenuItem>
                                     <DropdownMenuItem onClick={() => handleViewDocument(doc.id, "bill")}>
                                       <Eye className="h-4 w-4 mr-2" />
                                       Preview Bill
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

      {/* Record Bill Payment Dialog */}
      <RecordBillPaymentDialog
        bill={selectedBill}
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        onSuccess={() => {
          refreshBills();
          queryClient.invalidateQueries({ queryKey: ["aging-report"] });
        }}
      />

      {/* Bill Payment History Dialog */}
      <BillPaymentHistoryDialog
        bill={selectedBill}
        open={showBillPaymentHistory}
        onOpenChange={setShowBillPaymentHistory}
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
