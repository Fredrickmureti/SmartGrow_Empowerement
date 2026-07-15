import { normalizeError } from "@/services/resilience";
/**
 * Remittance Tracking Page
 *
 * Reads from the GL-backed `payroll_liabilities` ledger. "Record Payment"
 * calls the `post-remittance-payment` edge function which posts a real
 * journal entry (Dr each liability account / Cr bank) and inserts payment
 * + allocations. The trigger `trg_recompute_liab_on_alloc` derives
 * outstanding/paid/status from posted allocations only.
 *
 * Legacy `payroll_remittances` rows backfilled with `is_legacy_paid=true`
 * are surfaced with a banner — they had no GL impact when first recorded.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ReturnsTab } from "@/components/payroll/ReturnsTab";
import { RemittanceOperatorDashboard } from "@/components/payroll/RemittanceOperatorDashboard";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses as useBusinessesHook } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useAccounts } from "@/hooks/useAccounts";
import { format } from "date-fns";
import { Loader2, CheckCircle, Clock, AlertTriangle, Landmark, Info } from "lucide-react";

interface Liability {
  id: string;
  authority_name: string;
  rule_code: string;
  label: string;
  period_start: string;
  period_end: string;
  due_date: string | null;
  original_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  status: string; // open | partially_paid | paid | legacy_paid | void
  is_legacy_paid: boolean;
  liability_account_id: string | null;
  branch_id: string | null;
  country_code: string | null;
}

interface AllocationDraft {
  liability_id: string;
  amount: string; // input string for editability
  outstanding: number;
  label: string;
}

const STATUS_BADGE: Record<string, { cls: string; icon: any; label: string }> = {
  open:            { cls: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200", icon: Clock,         label: "Open" },
  partially_paid:  { cls: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",     icon: Clock,         label: "Partial" },
  paid:            { cls: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200", icon: CheckCircle,   label: "Paid" },
  legacy_paid:     { cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",     icon: Info,          label: "Legacy paid" },
  void:            { cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",     icon: Info,          label: "Void" },
};

export default function RemittanceTracking() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinessesHook();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { accounts } = useAccounts();

  // Deep-link support: /hr/payroll/statutory-remittances?template=NSSF_RET&from=2026-01-01&to=2026-07-31
  // is used by the Reporting Centre to hand off pack-artifact statutory reports
  // to the workflow that actually generates them. Honour those params so the
  // page lands on the Returns tab with the correct template + year preselected.
  const [searchParams] = useSearchParams();
  const deepLinkTemplate = searchParams.get("template") ?? undefined;
  const deepLinkFrom = searchParams.get("from") ?? undefined;
  const deepLinkYear = deepLinkFrom
    ? Number(deepLinkFrom.slice(0, 4)) || undefined
    : undefined;
  const initialTab = deepLinkTemplate ? "returns" : "liabilities";


  const [statusFilter, setStatusFilter] = useState<string>("outstanding");
  const [authorityFilter, setAuthorityFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDialog, setShowDialog] = useState(false);
  const [dialogAuthority, setDialogAuthority] = useState<string>("");
  const [allocations, setAllocations] = useState<AllocationDraft[]>([]);
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [paymentMethod, setPaymentMethod] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [notes, setNotes] = useState("");

  // Cash/bank accounts in this business
  const bankAccounts = useMemo(
    () => accounts.filter((a: any) =>
      String(a.account_type).toLowerCase() === "asset" &&
      (a.detail_type?.toLowerCase().includes("bank") || a.detail_type?.toLowerCase().includes("cash"))
    ),
    [accounts],
  );

  const { data: liabilities = [], isLoading } = useQuery({
    queryKey: ["payroll-liabilities", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_liabilities")
        .select("id, authority_name, rule_code, label, period_start, period_end, due_date, original_amount, paid_amount, outstanding_amount, status, is_legacy_paid, liability_account_id, branch_id, country_code")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("period_end", { ascending: false });
      if (error) throw error;
      return (data || []) as Liability[];
    },
  });

  const authorities = useMemo(() => {
    const s = new Set(liabilities.map((l) => l.authority_name).filter(Boolean));
    return Array.from(s).sort();
  }, [liabilities]);

  const filtered = useMemo(() => {
    return liabilities.filter((l) => {
      if (authorityFilter !== "all" && l.authority_name !== authorityFilter) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "outstanding") return l.status === "open" || l.status === "partially_paid";
      if (statusFilter === "overdue") {
        if (l.status === "paid" || l.status === "legacy_paid" || l.status === "void") return false;
        return l.due_date && new Date(l.due_date) < new Date();
      }
      return l.status === statusFilter;
    });
  }, [liabilities, statusFilter, authorityFilter]);

  // Summary by authority — outstanding only (excludes legacy_paid)
  const summary = useMemo(() => {
    const m = new Map<string, { outstanding: number; paid: number; legacy: number }>();
    for (const l of liabilities) {
      const e = m.get(l.authority_name) ?? { outstanding: 0, paid: 0, legacy: 0 };
      if (l.is_legacy_paid) e.legacy += Number(l.original_amount);
      else if (l.status === "paid") e.paid += Number(l.original_amount);
      else e.outstanding += Number(l.outstanding_amount);
      m.set(l.authority_name, e);
    }
    return m;
  }, [liabilities]);

  const totalOutstanding = useMemo(
    () => liabilities.filter((l) => l.status === "open" || l.status === "partially_paid")
      .reduce((s, l) => s + Number(l.outstanding_amount), 0),
    [liabilities],
  );
  const legacyCount = useMemo(() => liabilities.filter((l) => l.is_legacy_paid).length, [liabilities]);

  const toggleSelect = (l: Liability) => {
    if (l.status === "paid" || l.status === "legacy_paid" || l.status === "void") return;
    const next = new Set(selected);
    if (next.has(l.id)) next.delete(l.id);
    else next.add(l.id);
    setSelected(next);
  };

  const openPaymentDialog = (overrideIds?: string[]) => {
    const ids = overrideIds ?? Array.from(selected);
    const chosen = liabilities.filter((l) => ids.includes(l.id));
    if (chosen.length === 0) {
      toast({ title: "No liabilities selected", description: "Tick one or more outstanding liabilities, or use 'Pay all due' on an authority card.", variant: "destructive" });
      return;
    }
    const auths = new Set(chosen.map((c) => c.authority_name));
    if (auths.size !== 1) {
      toast({ title: "One authority at a time", description: "All allocations in a single payment must target the same authority.", variant: "destructive" });
      return;
    }
    const accts = new Set(chosen.map((c) => c.liability_account_id).filter(Boolean));
    if (accts.size === 0) {
      toast({ title: "Missing GL mapping", description: "These liabilities have no liability_account_id. Fix payroll GL mapping first.", variant: "destructive" });
      return;
    }
    if (overrideIds) setSelected(new Set(overrideIds));
    setDialogAuthority(chosen[0].authority_name);
    setAllocations(chosen.map((c) => ({
      liability_id: c.id,
      amount: Number(c.outstanding_amount).toFixed(2),
      outstanding: Number(c.outstanding_amount),
      label: `${c.label} · ${format(new Date(c.period_end), "MMM yyyy")}`,
    })));
    setBankAccountId(bankAccounts[0]?.id ?? "");
    setPaymentDate(format(new Date(), "yyyy-MM-dd"));
    setPaymentMethod("");
    setReferenceNumber("");
    setProofUrl("");
    setNotes("");
    setShowDialog(true);
  };

  const totalAllocated = useMemo(
    () => allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0),
    [allocations],
  );

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Missing org/business context");
      if (!bankAccountId) throw new Error("Select a bank/cash account");
      const cleaned = allocations
        .map((a) => ({ liability_id: a.liability_id, amount: parseFloat(a.amount) || 0, outstanding: a.outstanding }))
        .filter((a) => a.amount > 0);
      if (cleaned.length === 0) throw new Error("Enter at least one allocation amount");
      for (const a of cleaned) {
        if (a.amount > a.outstanding + 0.001) {
          throw new Error("An allocation exceeds its liability outstanding amount");
        }
      }
      const branchId = liabilities.find((l) => l.id === cleaned[0].liability_id)?.branch_id ?? null;
      const { data, error } = await supabase.functions.invoke("post-remittance-payment", {
        body: {
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: branchId,
          authority_name: dialogAuthority,
          payment_date: paymentDate,
          bank_account_id: bankAccountId,
          payment_method: paymentMethod || undefined,
          reference_number: referenceNumber || undefined,
          proof_url: proofUrl || undefined,
          notes: notes || undefined,
          allocations: cleaned.map((c) => ({ liability_id: c.liability_id, amount: c.amount })),
        },
      });
      if (error) throw new Error(error.message ?? "Edge function error");
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { payment_id: string; journal_entry_id: string; journal_entry_number: string; total_amount: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-liabilities"] });
      setSelected(new Set());
      setShowDialog(false);
      toast({
        title: "Remittance payment posted",
        description: `JE ${data.journal_entry_number} for ${formatCurrency(data.total_amount)}`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Failed to post remittance payment", description: normalizeError(err).message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const selectedLiabs = liabilities.filter((l) => selected.has(l.id));
  const selectedAuthorities = new Set(selectedLiabs.map((l) => l.authority_name));

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Statutory Remittances</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            GL-backed liability ledger. Recording a payment posts a real journal entry (Dr liability / Cr bank).
          </p>
        </div>
        {(() => {
          const isDisabled = selected.size === 0 || selectedAuthorities.size > 1;
          const reason =
            selected.size === 0
              ? "Tick one or more outstanding liabilities below to enable. Or use 'Pay all due' on an authority card."
              : selectedAuthorities.size > 1
                ? "Selection spans multiple authorities. A single payment must target one authority — narrow your selection."
                : "";
          const btn = (
            <Button onClick={() => openPaymentDialog()} disabled={isDisabled}>
              Record Payment ({selected.size})
            </Button>
          );
          return isDisabled ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild><span tabIndex={0}>{btn}</span></TooltipTrigger>
                <TooltipContent className="max-w-xs">{reason}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : btn;
        })()}
      </div>

      <Tabs defaultValue={initialTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="liabilities">Liabilities</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
        </TabsList>
        <TabsContent value="liabilities" className="space-y-4 sm:space-y-6 mt-0">
      <RemittanceOperatorDashboard />

      {legacyCount > 0 && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Legacy remittance entries detected</AlertTitle>
          <AlertDescription>
            {legacyCount} remittance row{legacyCount === 1 ? "" : "s"} {legacyCount === 1 ? "was" : "were"} marked
            paid before the GL-backed remittance flow shipped. They have <strong>no journal entry</strong> and are
            shown for reference only. New payments from this page now post Dr liability / Cr bank correctly.
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards */}
      <div className="stats-grid grid-cols-2 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><Clock className="h-5 w-5 text-amber-600" /></div>
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground truncate">Total Outstanding</p>
                <p className="text-lg sm:text-xl font-bold truncate">{formatCurrency(totalOutstanding)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        {Array.from(summary.entries()).slice(0, 3).map(([authority, vals]) => {
          const dueIds = liabilities
            .filter((l) => l.authority_name === authority && (l.status === "open" || l.status === "partially_paid"))
            .map((l) => l.id);
          return (
            <Card key={authority}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10"><Landmark className="h-5 w-5 text-primary" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-muted-foreground truncate">{authority}</p>
                    <p className="text-lg sm:text-xl font-bold truncate">{formatCurrency(vals.outstanding)}</p>
                  </div>
                </div>
                {dueIds.length > 0 && (
                  <Button
                    variant="outline" size="sm" className="mt-3 w-full"
                    onClick={() => openPaymentDialog(dueIds)}
                  >
                    Pay all due ({dueIds.length})
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filters + Table */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <CardTitle className="text-base">Liability Ledger</CardTitle>
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <Select value={authorityFilter} onValueChange={setAuthorityFilter}>
                <SelectTrigger className="w-full sm:w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Authorities</SelectItem>
                  {authorities.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outstanding">Outstanding</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="legacy_paid">Legacy paid</SelectItem>
                  <SelectItem value="all">All Status</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-center py-8 px-4">
              No liabilities match the current filters. Post a payroll run to GL to auto-generate liabilities.
            </p>
          ) : (
            <div className="hidden md:block table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]"></TableHead>
                    <TableHead>Authority</TableHead>
                    <TableHead>Liability</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Original</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((l) => {
                    const sb = STATUS_BADGE[l.status] ?? STATUS_BADGE.open;
                    const overdue = (l.status === "open" || l.status === "partially_paid") && l.due_date && new Date(l.due_date) < new Date();
                    const SI = sb.icon;
                    const selectable = l.status !== "paid" && l.status !== "legacy_paid" && l.status !== "void";
                    return (
                      <TableRow key={l.id} className={selected.has(l.id) ? "bg-muted/40" : ""}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(l.id)}
                            onCheckedChange={() => toggleSelect(l)}
                            disabled={!selectable}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{l.authority_name}</TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span>{l.label}</span>
                            <span className="text-xs text-muted-foreground">{l.rule_code}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(l.period_start), "MMM d")} – {format(new Date(l.period_end), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-sm">
                          {l.due_date ? (
                            <span className={overdue ? "text-destructive font-medium" : ""}>
                              {overdue && <AlertTriangle className="inline h-3 w-3 mr-1" />}
                              {format(new Date(l.due_date), "MMM d, yyyy")}
                            </span>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatCurrency(Number(l.original_amount))}</TableCell>
                        <TableCell className="text-right font-mono">{formatCurrency(Number(l.paid_amount))}</TableCell>
                        <TableCell className="text-right font-mono font-medium">{formatCurrency(Number(l.outstanding_amount))}</TableCell>
                        <TableCell>
                          <Badge className={sb.cls}><SI className="h-3 w-3 mr-1" />{sb.label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Mobile list */}
          <div className="md:hidden p-3 space-y-3">
            {filtered.map((l) => {
              const sb = STATUS_BADGE[l.status] ?? STATUS_BADGE.open;
              const SI = sb.icon;
              const selectable = l.status !== "paid" && l.status !== "legacy_paid" && l.status !== "void";
              return (
                <div key={l.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{l.authority_name} · {l.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {format(new Date(l.period_start), "MMM d")} – {format(new Date(l.period_end), "MMM d, yyyy")}
                      </div>
                    </div>
                    <Badge className={sb.cls}><SI className="h-3 w-3 mr-1" />{sb.label}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Original</span><div className="font-mono">{formatCurrency(Number(l.original_amount))}</div></div>
                    <div><span className="text-muted-foreground">Paid</span><div className="font-mono">{formatCurrency(Number(l.paid_amount))}</div></div>
                    <div><span className="text-muted-foreground">Outstanding</span><div className="font-mono font-medium">{formatCurrency(Number(l.outstanding_amount))}</div></div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t">
                    <span className="text-xs text-muted-foreground">
                      Due {l.due_date ? format(new Date(l.due_date), "MMM d, yyyy") : "—"}
                    </span>
                    <Checkbox
                      checked={selected.has(l.id)}
                      onCheckedChange={() => toggleSelect(l)}
                      disabled={!selectable}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Record Payment Dialog */}
        </TabsContent>
        <TabsContent value="returns" className="mt-0">
          <ReturnsTab />
        </TabsContent>
      </Tabs>

      <WorkflowSheet
        open={showDialog}
        onOpenChange={setShowDialog}
        title={`Record Remittance Payment — ${dialogAuthority}`}
        description="Posts Dr each liability account / Cr the selected bank account. Allocations may be partial."
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={recordPayment.isPending}>Cancel</Button>
            <Button
              onClick={() => recordPayment.mutate()}
              disabled={recordPayment.isPending || !bankAccountId || totalAllocated <= 0}
            >
              {recordPayment.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Post Payment
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Payment">
            <WorkflowField label="Payment date" required>
              <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            </WorkflowField>
            <WorkflowField label="Bank / cash account" required>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {bankAccounts.length === 0 && (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No bank/cash accounts found.</div>
                  )}
                  {bankAccounts.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>{a.code ? `${a.code} — ` : ""}{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Reference">
            <WorkflowField label="Payment method">
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                  <SelectItem value="cheque">Cheque</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="online">Online portal</SelectItem>
                  <SelectItem value="mobile_money">Mobile money</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Reference number">
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="e.g., bank ref, KRA receipt" />
            </WorkflowField>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection number={3} title="Supporting documents" fullWidth>
          <WorkflowField label="Proof URL">
            <Input value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} placeholder="https://… (receipt or filing acknowledgement)" />
          </WorkflowField>
          <WorkflowField label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={4} title="Allocations" fullWidth>
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Liability</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right w-[140px]">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocations.map((a, idx) => (
                  <TableRow key={a.liability_id}>
                    <TableCell className="text-sm">{a.label}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(a.outstanding)}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max={a.outstanding}
                        value={a.amount}
                        onChange={(e) => {
                          const next = [...allocations];
                          next[idx] = { ...a, amount: e.target.value };
                          setAllocations(next);
                        }}
                        className="text-right font-mono"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="px-3 py-2 border-t flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-mono font-semibold">{formatCurrency(totalAllocated)}</span>
            </div>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}
