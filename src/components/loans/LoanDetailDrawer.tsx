/**
 * LoanDetailDrawer — schedule, repayment ledger, and lifecycle actions.
 */
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle, PauseCircle, PlayCircle, XCircle, Banknote, ScrollText, Wallet } from "lucide-react";
import { format } from "date-fns";
import { useEmployeeLoans, type EmployeeLoan, type LoanScheduleRow, type LoanRepayment } from "@/hooks/useEmployeeLoans";
import { useAccounts } from "@/hooks/useAccounts";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-primary/10 text-primary",
  completed: "bg-emerald-500/10 text-emerald-600",
  cancelled: "bg-destructive/10 text-destructive",
  suspended: "bg-amber-500/10 text-amber-600",
};

interface Props {
  loan: EmployeeLoan | null;
  open: boolean;
  onClose: () => void;
}

export function LoanDetailDrawer({ loan, open, onClose }: Props) {
  const {
    approveLoan, authorizeDisbursement, suspendLoan, cancelLoan, pauseLoan, resumeLoan,
    disburseLoan, settleLoan, writeOffLoan, restructureLoan, recordManualRepayment,
    getSchedule, getRepayments,
  } = useEmployeeLoans();
  const { accounts } = useAccounts();

  const [schedule, setSchedule] = useState<LoanScheduleRow[]>([]);
  const [repayments, setRepayments] = useState<LoanRepayment[]>([]);
  const [pauseUntil, setPauseUntil] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [writeOffReason, setWriteOffReason] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualDate, setManualDate] = useState(new Date().toISOString().slice(0, 10));
  const [manualRef, setManualRef] = useState("");
  const [restructureReason, setRestructureReason] = useState("");
  const [restructureTerm, setRestructureTerm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loan || !open) return;
    Promise.all([getSchedule(loan.id), getRepayments(loan.id)]).then(([s, r]) => {
      setSchedule(s); setRepayments(r);
    });
  }, [loan?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loan) return null;

  const cashAccounts = accounts.filter((a) => a.account_type === "asset" && (a.detail_type?.toLowerCase().includes("bank") || a.detail_type?.toLowerCase().includes("cash")));
  const balance = loan.outstanding_balance;
  const paidPct = loan.total_amount > 0 ? Math.round((loan.amount_repaid / loan.total_amount) * 100) : 0;
  const canApprove = loan.status === "draft" || loan.status === "pending_approval" || loan.status === "requested";
  const canAuthorize = loan.status === "approved";
  const canDisburse = (loan.status === "approved" || loan.status === "awaiting_disbursement" || loan.status === "active")
    && !loan.disbursement_journal_entry_id && !!loan.type?.gl_receivable_account_id;
  const canSettle = (loan.status === "active" || loan.status === "in_arrears") && balance <= 0.005;
  const canWriteOff = ["active", "in_arrears", "suspended"].includes(loan.status) && balance > 0.005;

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="font-mono">{loan.loan_number}</SheetTitle>
            <Badge className={STATUS_BADGE[loan.status]}>{loan.status}</Badge>
          </div>
          <SheetDescription>
            {loan.employee ? `${loan.employee.first_name} ${loan.employee.last_name}` : loan.employee_id.slice(0, 8)}
            {loan.type && <> · <span className="capitalize">{loan.type.name}</span></>}
            {loan.paused_until && <> · <span className="text-amber-600">Paused until {loan.paused_until}</span></>}
          </SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <Stat label="Principal" value={loan.principal_amount} />
          <Stat label="Total" value={loan.total_amount} />
          <Stat label="Repaid" value={loan.amount_repaid} hint={`${paidPct}%`} />
          <Stat label="Outstanding" value={loan.outstanding_balance} highlight />
        </div>

        <Tabs defaultValue="schedule" className="mt-6">
          <TabsList>
            <TabsTrigger value="schedule"><ScrollText className="h-3.5 w-3.5 mr-1" />Schedule</TabsTrigger>
            <TabsTrigger value="repayments"><Wallet className="h-3.5 w-3.5 mr-1" />Repayments</TabsTrigger>
            <TabsTrigger value="actions"><Banknote className="h-3.5 w-3.5 mr-1" />Actions</TabsTrigger>
          </TabsList>

          <TabsContent value="schedule" className="space-y-2">
            {schedule.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">
                {loan.repayment_method === "percent_of_net"
                  ? "This loan uses percent-of-net recovery; no fixed schedule is generated."
                  : "Schedule will be generated on approval."}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted text-xs uppercase">
                  <tr>
                    <th className="p-2 text-left">#</th>
                    <th className="p-2 text-left">Period</th>
                    <th className="p-2 text-right">Scheduled</th>
                    <th className="p-2 text-right">Paid</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="p-2">{s.sequence}</td>
                      <td className="p-2">{s.due_period_start} → {s.due_period_end}</td>
                      <td className="p-2 text-right font-mono">{s.scheduled_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="p-2 text-right font-mono">{s.paid_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-[10px] capitalize">{s.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>

          <TabsContent value="repayments" className="space-y-2">
            {repayments.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">No repayments recorded.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted text-xs uppercase">
                  <tr>
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Installment</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {repayments.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">{format(new Date(r.repayment_date || r.created_at), "MMM d, yyyy")}</td>
                      <td className="p-2">#{r.installment_number}</td>
                      <td className="p-2 text-right font-mono">{Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="p-2 text-xs text-muted-foreground">{r.payroll_run_id ? "Payroll" : "Manual"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>

          <TabsContent value="actions" className="space-y-4">
            {canApprove && (
              <Button disabled={busy} onClick={() => wrap(() => approveLoan(loan.id))}>
                <CheckCircle className="h-4 w-4 mr-2" /> Approve
              </Button>
            )}

            {canAuthorize && (
              <Button disabled={busy} onClick={() => wrap(() => authorizeDisbursement(loan.id))}>
                <CheckCircle className="h-4 w-4 mr-2" /> Authorize for disbursement
              </Button>
            )}

            {canDisburse && (
              <div className="space-y-2 border rounded-md p-3">
                <Label>Disburse from</Label>
                <Select value={bankAccountId} onValueChange={setBankAccountId}>
                  <SelectTrigger><SelectValue placeholder="Select bank/cash account" /></SelectTrigger>
                  <SelectContent>
                    {cashAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  disabled={!bankAccountId || busy}
                  onClick={() => wrap(async () => { await disburseLoan(loan.id, bankAccountId); })}
                >
                  <Banknote className="h-4 w-4 mr-2" /> Disburse & post journal
                </Button>
              </div>
            )}

            {(loan.status === "active" || loan.status === "in_arrears") && !loan.paused_until && (
              <div className="space-y-2 border rounded-md p-3">
                <Label>Pause recovery until</Label>
                <Input type="date" value={pauseUntil} onChange={(e) => setPauseUntil(e.target.value)} />
                <Button variant="outline" disabled={!pauseUntil || busy} onClick={() => wrap(async () => { await pauseLoan(loan.id, pauseUntil); })}>
                  <PauseCircle className="h-4 w-4 mr-2" /> Pause
                </Button>
              </div>
            )}
            {loan.paused_until && (
              <Button variant="outline" disabled={busy} onClick={() => wrap(() => resumeLoan(loan.id))}>
                <PlayCircle className="h-4 w-4 mr-2" /> Resume recovery
              </Button>
            )}

            {(loan.status === "active" || loan.status === "in_arrears") && (
              <div className="space-y-2 border rounded-md p-3">
                <Label>Manual repayment (off-payroll)</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input type="number" step="0.01" placeholder="Amount" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} />
                  <Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} />
                </div>
                <Select value={bankAccountId} onValueChange={setBankAccountId}>
                  <SelectTrigger><SelectValue placeholder="Bank/cash account" /></SelectTrigger>
                  <SelectContent>
                    {cashAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input placeholder="Reference (optional)" value={manualRef} onChange={(e) => setManualRef(e.target.value)} />
                <Button
                  variant="outline"
                  disabled={busy || !manualAmount || !bankAccountId}
                  onClick={() => wrap(async () => {
                    await recordManualRepayment(loan.id, Number(manualAmount), manualDate, bankAccountId, manualRef || undefined);
                    setManualAmount(""); setManualRef("");
                  })}
                >
                  <Wallet className="h-4 w-4 mr-2" /> Record manual repayment
                </Button>
              </div>
            )}

            {(loan.status === "active" || loan.status === "in_arrears") && (
              <div className="space-y-2 border rounded-md p-3">
                <Label>Restructure (new term in months, optional)</Label>
                <Input type="number" placeholder="New term months" value={restructureTerm} onChange={(e) => setRestructureTerm(e.target.value)} />
                <Input placeholder="Reason" value={restructureReason} onChange={(e) => setRestructureReason(e.target.value)} />
                <Button
                  variant="outline"
                  disabled={busy || !restructureReason}
                  onClick={() => wrap(async () => {
                    await restructureLoan(loan.id, {
                      new_term_months: restructureTerm ? Number(restructureTerm) : undefined,
                      reason: restructureReason,
                    });
                    setRestructureReason(""); setRestructureTerm("");
                  })}
                >
                  <ScrollText className="h-4 w-4 mr-2" /> Restructure
                </Button>
              </div>
            )}

            {canSettle && (
              <Button disabled={busy} onClick={() => wrap(() => settleLoan(loan.id))}>
                <CheckCircle className="h-4 w-4 mr-2" /> Settle (zero balance)
              </Button>
            )}

            {canWriteOff && (
              <div className="space-y-2 border rounded-md p-3 border-destructive/40">
                <Label className="text-destructive">Write-off (dual control)</Label>
                <Input placeholder="Reason / approval reference" value={writeOffReason} onChange={(e) => setWriteOffReason(e.target.value)} />
                <Button
                  variant="destructive"
                  disabled={busy || !writeOffReason}
                  onClick={() => wrap(async () => {
                    await writeOffLoan(loan.id, writeOffReason);
                    setWriteOffReason("");
                  })}
                >
                  <XCircle className="h-4 w-4 mr-2" /> Write off outstanding balance
                </Button>
              </div>
            )}

            {(loan.status === "active" || loan.status === "in_arrears") && (
              <Button variant="outline" disabled={busy} onClick={() => wrap(() => suspendLoan(loan.id))}>
                <PauseCircle className="h-4 w-4 mr-2" /> Suspend
              </Button>
            )}
            {(loan.status === "draft" || loan.status === "pending_approval" || loan.status === "requested" || loan.status === "suspended" || loan.status === "approved") && (
              <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => wrap(() => cancelLoan(loan.id))}>
                <XCircle className="h-4 w-4 mr-2" /> Cancel
              </Button>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value, hint, highlight }: { label: string; value: number; hint?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${highlight ? "border-primary bg-primary/5" : ""}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-mono">{value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
