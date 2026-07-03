/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { financeKey } from "@/lib/finance/financeKey";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  Search,
  Users,
  DollarSign,
  FileText,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Eye,
  MoreHorizontal,
  CreditCard,
  Wallet,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ApplyCreditDialog } from "@/components/finance/ApplyCreditDialog";
import { CreditNotePeekSheet } from "@/features/sales/credit-notes/CreditNotePeekSheet";

// ─── Types ────────────────────────────────────────────────────────
interface CustomerGroup {
  contact_id: string;
  contact_name: string;
  total_credit: number;
  total_applied: number;
  total_available: number;
  credit_notes: CreditRowEnriched[];
}

interface CreditRowEnriched {
  id: string;
  credit_note_number: string;
  total: number;
  amount_applied: number;
  refund_amount: number;
  available: number;
  issue_date: string;
  reason: string;
  status: string;
  contact_name: string;
  contact_id: string;
}

interface ApplicationRow {
  id: string;
  credit_note_number: string;
  invoice_number: string;
  amount: number;
  applied_at: string;
  notes: string | null;
  contact_name: string;
}

// ─── Component ────────────────────────────────────────────────────
export default function CustomerCredits() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const { creditNotes: fullCreditNotes } = useCreditNotes();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Phase 4: branch-aware Finance scope. branchId is part of the cache key
  // and the query predicate so a branch switch invalidates AND refetches the
  // correct slice with no stale rows on screen.
  const scope = useFinanceScope();
  const { branchId } = scope;

  const [searchQuery, setSearchQuery] = useState(searchParams.get("customer") || "");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set());

  // Apply credit dialog state
  const [applyCreditOpen, setApplyCreditOpen] = useState(false);
  const [applyCreditTarget, setApplyCreditTarget] = useState<{
    creditNoteId: string;
    creditNoteNumber: string;
    contactId: string;
    contactName: string;
    availableAmount: number;
  } | null>(null);

  // Peek sheet state — canonical Sales credit-note peek surface.
  const [peekId, setPeekId] = useState<string | null>(null);

  useEffect(() => {
    const creditId = searchParams.get("id");
    if (!creditId || !fullCreditNotes.length) return;

    const match = fullCreditNotes.find((credit) => credit.id === creditId);
    if (!match) return;

    setPeekId(match.id);

    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, fullCreditNotes, setSearchParams]);

  // ── Fetch credit notes (branch-scoped) ──
  const { data: credits = [], isLoading } = useQuery({
    queryKey: financeKey(scope, "customer-credits", "list"),
    queryFn: async (): Promise<CreditRowEnriched[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      let q = supabase
        .from("credit_notes")
        .select("id, credit_note_number, total, amount_applied, refund_amount, issue_date, reason, status, contact_id, branch_id, contact:contacts(name)")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("status", ["issued", "applied"]);
      if (branchId) {
        // Branch users see their branch's credits + legacy/company-shared
        // (NULL-branch) credits. Sibling branches stay hidden.
        q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      }
      const { data, error } = await q.order("issue_date", { ascending: false });
      if (error) throw error;

      return (data || []).map((cn: any) => ({
        id: cn.id,
        credit_note_number: cn.credit_note_number,
        total: cn.total,
        amount_applied: cn.amount_applied || 0,
        refund_amount: cn.refund_amount || 0,
        available: cn.total - (cn.amount_applied || 0) - (cn.refund_amount || 0),
        issue_date: cn.issue_date,
        reason: cn.reason || "",
        status: cn.status,
        contact_name: cn.contact?.name || "Unknown",
        contact_id: cn.contact_id,
      }));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // ── Fetch application history (branch-scoped) ──
  const { data: applicationHistory = [], isLoading: appsLoading } = useQuery({
    queryKey: financeKey(scope, "customer-credits", "history"),
    queryFn: async (): Promise<ApplicationRow[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];
      // Phase 4 migration added business_id + branch_id directly on
      // credit_note_applications, so we filter on the row itself rather
      // than scoping via the parent credit_note join. RLS + this predicate
      // together guarantee branch isolation.
      const client: any = supabase;
      let q: any = client
        .from("credit_note_applications")
        .select("id, amount, applied_at, notes, branch_id, credit_note:credit_notes!inner(credit_note_number, contact:contacts(name)), invoice:invoices(invoice_number)")
        .eq("business_id", currentBusiness.id);
      if (branchId) {
        q = q.or(`branch_id.eq.${branchId},branch_id.is.null`);
      }
      const { data, error } = await q.order("applied_at", { ascending: false }).limit(200);

      if (error) throw error;
      return ((data as any[]) || []).map((a: any) => ({
        id: a.id,
        credit_note_number: a.credit_note?.credit_note_number || "—",
        invoice_number: a.invoice?.invoice_number || "—",
        amount: a.amount,
        applied_at: a.applied_at,
        notes: a.notes,
        contact_name: a.credit_note?.contact?.name || "Unknown",
      }));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  // ── Computed: filter & group ──
  const filtered = useMemo(() => {
    let list = credits;
    if (statusFilter === "open") list = list.filter((c) => c.available > 0);
    if (statusFilter === "applied") list = list.filter((c) => c.available <= 0);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.contact_name.toLowerCase().includes(q) ||
          c.credit_note_number.toLowerCase().includes(q) ||
          c.reason.toLowerCase().includes(q)
      );
    }
    return list;
  }, [credits, searchQuery, statusFilter]);

  const customerGroups = useMemo(() => {
    const map = new Map<string, CustomerGroup>();
    for (const cn of filtered) {
      let group = map.get(cn.contact_id);
      if (!group) {
        group = {
          contact_id: cn.contact_id,
          contact_name: cn.contact_name,
          total_credit: 0,
          total_applied: 0,
          total_available: 0,
          credit_notes: [],
        };
        map.set(cn.contact_id, group);
      }
      group.total_credit += cn.total;
      group.total_applied += cn.amount_applied;
      group.total_available += cn.available;
      group.credit_notes.push(cn);
    }
    return Array.from(map.values()).sort((a, b) => b.total_available - a.total_available);
  }, [filtered]);

  // ── Summary ──
  const totalCredits = credits.reduce((s, c) => s + c.total, 0);
  const totalApplied = credits.reduce((s, c) => s + c.amount_applied, 0);
  const totalAvailable = credits.reduce((s, c) => s + c.available, 0);
  const customersWithCredit = new Set(credits.filter((c) => c.available > 0).map((c) => c.contact_id)).size;

  // ── Helpers ──
  const toggleCustomer = (id: string) => {
    setExpandedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => setExpandedCustomers(new Set(customerGroups.map((g) => g.contact_id)));
  const collapseAll = () => setExpandedCustomers(new Set());

  const openApplyCredit = (cn: CreditRowEnriched) => {
    setApplyCreditTarget({
      creditNoteId: cn.id,
      creditNoteNumber: cn.credit_note_number,
      contactId: cn.contact_id,
      contactName: cn.contact_name,
      availableAmount: cn.available,
    });
    setApplyCreditOpen(true);
  };

  const openDetail = (cn: CreditRowEnriched) => {
    setPeekId(cn.id);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["all-customer-credits"] });
    queryClient.invalidateQueries({ queryKey: ["credit-application-history"] });
    queryClient.invalidateQueries({ queryKey: ["customer-credits"] });
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
          <h1 className="page-title">Customer Credits</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage overpayments, advance payments, and unapplied customer credit balances
          </p>
          <div className="mt-2"><FinanceScopeBadge /></div>
        </div>
        <RefreshButton
          queryKeyPrefixes={[
            ['credit-notes'] as const,
            ['payments'] as const,
          ]}
          tooltip="Refresh credits"
        />
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Credits Issued</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">{formatCurrency(totalCredits)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <FileText className="h-3 w-3 inline mr-1" />
              {credits.length} credit note{credits.length !== 1 ? "s" : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Applied to Invoices</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-emerald-600 tabular-nums">{formatCurrency(totalApplied)}</div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-primary">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Available Credit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold text-primary tabular-nums">{formatCurrency(totalAvailable)}</div>
            <p className="text-xs text-muted-foreground mt-1">Unapplied balance</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Customers with Credit</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">{customersWithCredit}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <Users className="h-3 w-3 inline mr-1" />
              Active balances
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Tabbed Workspace ── */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">
            <Users className="h-4 w-4 mr-1.5" />
            By Customer
          </TabsTrigger>
          <TabsTrigger value="all">
            <FileText className="h-4 w-4 mr-1.5" />
            All Credit Notes
          </TabsTrigger>
          <TabsTrigger value="history">
            <Clock className="h-4 w-4 mr-1.5" />
            Application History
          </TabsTrigger>
        </TabsList>

        {/* ── Filters (shared) ── */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between mt-4">
          <div className="flex flex-col sm:flex-row gap-3 flex-1">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search customer, credit note #, reason..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="open">Open (Unapplied)</SelectItem>
                <SelectItem value="applied">Fully Applied</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
            <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
          </div>
        </div>

        {/* ── Tab 1: By Customer ── */}
        <TabsContent value="overview" className="mt-4">
          {customerGroups.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-emerald-500" />
                <p className="font-medium">No customer credits found</p>
                <p className="text-sm mt-1">Credits are created from overpayments, returns, or manual adjustments.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {customerGroups.map((group) => {
                const isExpanded = expandedCustomers.has(group.contact_id);
                return (
                  <Card key={group.contact_id}>
                    <Collapsible open={isExpanded} onOpenChange={() => toggleCustomer(group.contact_id)}>
                      <CollapsibleTrigger asChild>
                        <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors">
                          <div className="flex items-center gap-3">
                            {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            <div>
                              <div className="font-semibold">{group.contact_name}</div>
                              <div className="text-xs text-muted-foreground">
                                {group.credit_notes.length} credit note{group.credit_notes.length !== 1 ? "s" : ""}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-6 text-sm">
                            <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground">
                              <span>Issued: {formatCurrency(group.total_credit)}</span>
                              <span className="text-emerald-600">Applied: {formatCurrency(group.total_applied)}</span>
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-base text-primary">{formatCurrency(group.total_available)}</div>
                              <div className="text-xs text-muted-foreground">available</div>
                            </div>
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-muted/30">
                                <TableHead className="text-xs">Credit Note #</TableHead>
                                <TableHead className="text-xs">Date</TableHead>
                                <TableHead className="text-xs">Reason</TableHead>
                                <TableHead className="text-xs text-right">Total</TableHead>
                                <TableHead className="text-xs text-right">Applied</TableHead>
                                <TableHead className="text-xs text-right">Available</TableHead>
                                <TableHead className="text-xs">Status</TableHead>
                                <TableHead className="w-[50px]" />
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {group.credit_notes.map((cn) => (
                                <TableRow key={cn.id}>
                                  <TableCell className="font-mono text-sm">{cn.credit_note_number}</TableCell>
                                  <TableCell className="text-sm">{format(parseISO(cn.issue_date), "dd MMM yyyy")}</TableCell>
                                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{cn.reason || "—"}</TableCell>
                                  <TableCell className="text-right text-sm">{formatCurrency(cn.total)}</TableCell>
                                  <TableCell className="text-right text-sm text-emerald-600">{formatCurrency(cn.amount_applied)}</TableCell>
                                  <TableCell className="text-right font-semibold text-sm">
                                    {cn.available > 0 ? (
                                      <span className="text-primary">{formatCurrency(cn.available)}</span>
                                    ) : (
                                      <span className="text-muted-foreground">{formatCurrency(0)}</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {cn.available > 0 ? (
                                      <Badge variant="default" className="text-xs">Open</Badge>
                                    ) : (
                                      <Badge variant="secondary" className="text-xs">Applied</Badge>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" className="h-7 w-7">
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => openDetail(cn)}>
                                          <Eye className="h-4 w-4 mr-2" />
                                          View Details
                                        </DropdownMenuItem>
                                        {cn.available > 0 && (
                                          <DropdownMenuItem onClick={() => openApplyCredit(cn)}>
                                            <ArrowRight className="h-4 w-4 mr-2" />
                                            Apply to Invoice
                                          </DropdownMenuItem>
                                        )}
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
        </TabsContent>

        {/* ── Tab 2: All Credit Notes (flat) ── */}
        <TabsContent value="all" className="mt-4">
          {filtered.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                <p className="font-medium">No credit notes found</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Credit Note #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Applied</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[50px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((credit) => (
                    <TableRow key={credit.id} className="cursor-pointer" onClick={() => openDetail(credit)}>
                      <TableCell className="font-mono text-sm">{credit.credit_note_number}</TableCell>
                      <TableCell className="font-medium">{credit.contact_name}</TableCell>
                      <TableCell className="text-sm">{format(parseISO(credit.issue_date), "dd MMM yyyy")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{credit.reason || "—"}</TableCell>
                      <TableCell className="text-right text-sm">{formatCurrency(credit.total)}</TableCell>
                      <TableCell className="text-right text-sm text-emerald-600">{formatCurrency(credit.amount_applied)}</TableCell>
                      <TableCell className="text-right font-semibold text-sm">
                        {credit.available > 0 ? (
                          <span className="text-primary">{formatCurrency(credit.available)}</span>
                        ) : (
                          <span className="text-muted-foreground">{formatCurrency(0)}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {credit.available > 0 ? (
                          <Badge variant="default" className="text-xs">Open</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Applied</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openDetail(credit); }}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            {credit.available > 0 && (
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openApplyCredit(credit); }}>
                                <ArrowRight className="h-4 w-4 mr-2" />
                                Apply to Invoice
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── Tab 3: Application History ── */}
        <TabsContent value="history" className="mt-4">
          {appsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : applicationHistory.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Clock className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                <p className="font-medium">No credit applications yet</p>
                <p className="text-sm mt-1">Applications will appear here when credits are applied to invoices.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Credit Note</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {applicationHistory.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell className="text-sm">{format(parseISO(app.applied_at), "dd MMM yyyy")}</TableCell>
                      <TableCell className="font-medium text-sm">{app.contact_name}</TableCell>
                      <TableCell className="font-mono text-sm">{app.credit_note_number}</TableCell>
                      <TableCell className="font-mono text-sm">{app.invoice_number}</TableCell>
                      <TableCell className="text-right font-semibold text-sm text-emerald-600">
                        {formatCurrency(app.amount)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{app.notes || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Dialogs ── */}
      {applyCreditTarget && (
        <ApplyCreditDialog
          open={applyCreditOpen}
          onOpenChange={setApplyCreditOpen}
          creditNoteId={applyCreditTarget.creditNoteId}
          creditNoteNumber={applyCreditTarget.creditNoteNumber}
          contactId={applyCreditTarget.contactId}
          contactName={applyCreditTarget.contactName}
          availableAmount={applyCreditTarget.availableAmount}
          onSuccess={handleRefresh}
        />
      )}

      <CreditNotePeekSheet
        creditNoteId={peekId}
        onOpenChange={(open) => { if (!open) setPeekId(null); }}
      />
    </div>
  );
}
