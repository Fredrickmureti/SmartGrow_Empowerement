/**
 * Lending → Loans (C6).
 *
 * The loan is minted server-side from an approved application and carries a
 * frozen snapshot of its product version. Disbursement is a guarded, one-shot
 * business event. This page only lists the book and collects operator intent —
 * no balance, interest or schedule maths happens here.
 */
import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import {
  Ban,
  CalendarRange,
  CheckCircle2,
  HandCoins,
  Plus,
  RefreshCw,
  TrendingUp,
  Undo2,

} from "lucide-react";

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
  MF_LINEAGE_LABELS,
  MF_LOAN_STATUSES,
  MF_LOAN_STATUS_LABELS,
  useMfLoans,
  type MfLoan,
  type MfLoanStatus,
} from "@/hooks/useMfLoans";
import { LendingDocumentsMenu } from "../documents/LendingDocumentsMenu";
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

/**
 * What each loan state means and what happens next, in business terms.
 * Mirrors the guards in `mf_disburse_loan` and the lifecycle RPCs.
 */
const LOAN_STATE_GUIDANCE: Record<MfLoanStatus, string> = {
  pending_disbursement:
    "Contract and schedule exist; no money has moved. Next: disburse the loan.",
  active: "Money paid out and repayments are due. Next: record repayments as they are collected.",
  closed: "Fully settled. No further lifecycle events apply.",
  written_off: "Recognised as a loss. Recoveries only.",
  cancelled: "Cancelled before disbursement. No further events apply.",
};

const money = (value: number, currency: string) =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function LoansPage() {
  const { can } = usePermissions();
  const canManage = can("manageLoans");
  const canDisburse = can("disburseLoans");
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

  const {
    loans,
    isLoading,
    error,
    createFromApplication,
    disburse,
    reverseDisbursement,
    writeOff,
    closeLoan,
    reissueLoan,
    cancelPendingLoan,
  } = useMfLoans({ status });
  const { clients } = useMfClients();


  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  /** Registration portrait of a client, for payout identity comparison. */
  const clientPhotoPath = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, c.photo_path]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? null) : null);
  }, [clients]);

  const loanNumber = useMemo(() => {
    const map = new Map(loans.map((l) => [l.id, l.loan_number]));
    return (id: string | null) => (id ? (map.get(id) ?? "—") : null);
  }, [loans]);

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
          canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Create loan
            </Button>
          ) : undefined
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
              action={canManage ? <Button onClick={() => setCreateOpen(true)}>Create loan</Button> : undefined}
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
                    <TableCell className="font-mono text-xs">
                      {loan.loan_number}
                      {loan.lineage_kind !== "new" && (
                        <div className="mt-0.5 font-sans text-[11px] text-muted-foreground">
                          {MF_LINEAGE_LABELS[loan.lineage_kind]} of{" "}
                          {loanNumber(loan.parent_loan_id) ?? "—"}
                        </div>
                      )}
                      {loan.settled_by_loan_id && (
                        <div className="mt-0.5 font-sans text-[11px] text-muted-foreground">
                          Replaced by {loanNumber(loan.settled_by_loan_id)}
                        </div>
                      )}
                    </TableCell>
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
                    <TableCell className="min-w-[240px] space-y-1">
                      <StatusBadge tone={STATUS_TONE[loan.status]}>
                        {MF_LOAN_STATUS_LABELS[loan.status]}
                      </StatusBadge>
                      {/* What has happened, and the next legitimate event. The
                          database remains the authority; this only explains it. */}
                      <p className="text-xs text-muted-foreground">
                        {LOAN_STATE_GUIDANCE[loan.status]}
                      </p>
                    </TableCell>
                    <TableCell
                      className="space-x-1.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button size="sm" variant="outline" onClick={() => openSchedule(loan)}>
                        <CalendarRange className="mr-1.5 h-3.5 w-3.5" />
                        Schedule
                      </Button>
                      <LendingDocumentsMenu
                        documents={[
                          {
                            documentType: "loan_agreement",
                            documentId: loan.id,
                            title: `Loan agreement ${loan.loan_number}`,
                            filename: `loan-agreement-${loan.loan_number}`,
                          },
                          {
                            documentType: "repayment_schedule",
                            documentId: loan.id,
                            title: `Repayment schedule ${loan.loan_number}`,
                            filename: `repayment-schedule-${loan.loan_number}`,
                            spreadsheet: true,
                          },
                          {
                            documentType: "loan_statement",
                            documentId: loan.id,
                            title: `Loan statement ${loan.loan_number}`,
                            filename: `loan-statement-${loan.loan_number}`,
                          },
                        ]}
                      />
                      {canDisburse && loan.status === "pending_disbursement" && (

                        <Button size="sm" onClick={() => openDisburse(loan)}>
                          <HandCoins className="mr-1.5 h-3.5 w-3.5" />
                          Disburse
                        </Button>
                      )}
                      {canManage && loan.status === "pending_disbursement" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLifecycle(loan, "cancel")}
                          >
                            <Ban className="mr-1.5 h-3.5 w-3.5" />
                            Cancel loan
                          </Button>
                          <span className="text-xs text-muted-foreground">
                            Wrong amount, term or client? Cancel the loan and book a corrected
                            application. Top-up, restructure, closure and write-off become
                            available once the loan has been disbursed.
                          </span>
                        </>
                      )}
                      {canManage && loan.status === "active" && !loan.settled_by_loan_id && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLifecycle(loan, "top_up")}
                          >
                            <TrendingUp className="mr-1.5 h-3.5 w-3.5" />
                            Top up
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLifecycle(loan, "restructure")}
                          >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            Restructure
                          </Button>
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
                            variant="outline"
                            onClick={() => openLifecycle(loan, "reverse_disbursement")}
                          >
                            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                            Reverse disbursement
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
        clientPhotoPath={clientPhotoPath(disburseTarget?.client_id)}
        clientName={disburseTarget ? clientName(disburseTarget.client_id) : null}
        onDisburse={async (input) => {
          await disburse.mutateAsync(input);
        }}
      />

      <LoanScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        loan={scheduleTarget}
        clientPhotoPath={clientPhotoPath(scheduleTarget?.client_id)}
      />

      <LoanLifecycleDialog
        open={lifecycleOpen}
        onOpenChange={setLifecycleOpen}
        loan={lifecycleTarget}
        action={lifecycleAction}
        onWriteOff={async (input) => {
          await writeOff.mutateAsync(input);
        }}
        onClose={async (input) => {
          await closeLoan.mutateAsync(input);
        }}
        onReissue={async (input) => {
          await reissueLoan.mutateAsync(input);
        }}
        onReverseDisbursement={async (input) => {
          await reverseDisbursement.mutateAsync(input);
        }}
        onCancelLoan={async (input) => {
          await cancelPendingLoan.mutateAsync(input);
        }}
      />

    </>
  );
}

export default LoansPage;
