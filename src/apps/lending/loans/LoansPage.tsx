/**
 * Lending → Loans (C6).
 *
 * The loan is minted server-side from an approved application and carries a
 * frozen snapshot of its product version. Disbursement is a guarded, one-shot
 * business event. This page only lists the book and collects operator intent —
 * no balance, interest or schedule maths happens here.
 */
import { useMemo, useState } from "react";
import { Ban, CalendarRange, CheckCircle2, HandCoins, Plus } from "lucide-react";

import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
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
import { useMfClients } from "@/hooks/useMfClients";
import {
  MF_LOAN_STATUSES,
  MF_LOAN_STATUS_LABELS,
  useMfLoans,
  type MfLoan,
  type MfLoanStatus,
} from "@/hooks/useMfLoans";
import { CreateLoanDialog } from "./CreateLoanDialog";
import { DisburseDialog } from "./DisburseDialog";
import { LoanScheduleDialog } from "./LoanScheduleDialog";
import { LoanLifecycleDialog, type LoanLifecycleAction } from "./LoanLifecycleDialog";


const STATUS_TONE: Record<
  MfLoanStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  pending_disbursement: "warning",
  active: "success",
  closed: "neutral",
  written_off: "danger",
  cancelled: "neutral",
};

const money = (value: number, currency: string) =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function LoansPage() {
  const [status, setStatus] = useState<MfLoanStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [disburseTarget, setDisburseTarget] = useState<MfLoan | null>(null);
  const [disburseOpen, setDisburseOpen] = useState(false);
  const [scheduleTarget, setScheduleTarget] = useState<MfLoan | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [lifecycleTarget, setLifecycleTarget] = useState<MfLoan | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<LoanLifecycleAction>("write_off");
  const [lifecycleOpen, setLifecycleOpen] = useState(false);

  const { loans, isLoading, error, createFromApplication, disburse, writeOff, closeLoan } =
    useMfLoans({ status });
  const { clients } = useMfClients();


  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return loans;
    return loans.filter((l) =>
      [l.loan_number, clientName(l.client_id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [loans, search, clientName]);

  const openSchedule = (loan: MfLoan) => {
    setScheduleTarget(loan);
    setScheduleOpen(true);
  };

  const openDisburse = (loan: MfLoan) => {
    setDisburseTarget(loan);
    setDisburseOpen(true);
  };

  const openLifecycle = (loan: MfLoan, action: LoanLifecycleAction) => {
    setLifecycleTarget(loan);
    setLifecycleAction(action);
    setLifecycleOpen(true);
  };


  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Loans"
        description="Contractual loans with a frozen product snapshot, their schedules and guarded disbursement."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Create loan
          </Button>
        }
      />
      <PageBody>
        <Section title="Loan book" description={`${filtered.length} loan(s)`}>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search loan number or client…"
          >
            <Select value={status} onValueChange={(v) => setStatus(v as MfLoanStatus | "all")}>
              <SelectTrigger className="h-8 w-[200px] text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {MF_LOAN_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {MF_LOAN_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No loans yet"
              description="Approve an application, then create the loan to generate its contractual schedule."
              action={<Button onClick={() => setCreateOpen(true)}>Create loan</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loan</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Term</TableHead>
                  <TableHead>Disbursement</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((loan) => (
                  <TableRow
                    key={loan.id}
                    className="cursor-pointer"
                    onClick={() => openSchedule(loan)}
                  >
                    <TableCell className="font-mono text-xs">{loan.loan_number}</TableCell>
                    <TableCell className="font-medium">{clientName(loan.client_id)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(loan.principal, loan.currency_code)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {loan.term_installments} × {loan.repayment_frequency}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {loan.disbursed_at
                        ? new Date(loan.disbursed_at).toISOString().slice(0, 10)
                        : loan.expected_disbursement_date
                          ? `Expected ${loan.expected_disbursement_date}`
                          : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[loan.status]}>
                        {MF_LOAN_STATUS_LABELS[loan.status]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell
                      className="space-x-1.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button size="sm" variant="outline" onClick={() => openSchedule(loan)}>
                        <CalendarRange className="mr-1.5 h-3.5 w-3.5" />
                        Schedule
                      </Button>
                      {loan.status === "pending_disbursement" && (
                        <Button size="sm" onClick={() => openDisburse(loan)}>
                          <HandCoins className="mr-1.5 h-3.5 w-3.5" />
                          Disburse
                        </Button>
                      )}
                      {loan.status === "active" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLifecycle(loan, "close")}
                          >
                            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                            Close
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => openLifecycle(loan, "write_off")}
                          >
                            <Ban className="mr-1.5 h-3.5 w-3.5" />
                            Write off
                          </Button>
                        </>
                      )}

                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <CreateLoanDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          await createFromApplication.mutateAsync({
            applicationId: input.applicationId,
            expectedDisbursementDate: input.expectedDisbursementDate,
            firstInstallmentDate: input.firstInstallmentDate,
          });
        }}
      />

      <DisburseDialog
        open={disburseOpen}
        onOpenChange={setDisburseOpen}
        loan={disburseTarget}
        onDisburse={async (input) => {
          await disburse.mutateAsync(input);
        }}
      />

      <LoanScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        loan={scheduleTarget}
      />
    </>
  );
}

export default LoansPage;
