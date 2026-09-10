/**
 * Lending → Applications (C5).
 *
 * Draft → Submitted → Under review → Approved/Rejected → Ready for
 * disbursement. Each move is a request to the database guard, which owns
 * legality, decision authority and the product band; this page only shows the
 * pipeline and collects the operator's intent.
 */
import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Check, ChevronRight, ClipboardCheck, MoreHorizontal, Plus } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
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
  useMfLoanProducts,
  useMfProductVersionIndex,
} from "@/hooks/useMfLoanProducts";
import {
  MF_APPLICATION_STATUSES,
  MF_APPLICATION_STATUS_LABELS,
  useMfApplications,
  useMfAssessedApplicationIds,
  type MfApplicationStatus,
  type MfLoanApplication,
} from "@/hooks/useMfApplications";
import { useMfLoans } from "@/hooks/useMfLoans";
import {
  decisionBlockedReason,
  describeApplicationWorkflow,
} from "@/lib/lending/applicationWorkflow";
import { CreateLoanDialog } from "../loans/CreateLoanDialog";
import { ApplicationFormDialog } from "./ApplicationFormDialog";
import { AssessmentDialog } from "./AssessmentDialog";
import { DecisionDialog } from "./DecisionDialog";
import { WithdrawDialog } from "./WithdrawDialog";
import { DeleteDeclinedDialog } from "./DeleteDeclinedDialog";

const STATUS_TONE: Record<
  MfApplicationStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  under_review: "warning",
  approved: "success",
  rejected: "danger",
  ready_for_disbursement: "info",
  disbursed: "success",
  cancelled: "neutral",
};

/** Completed events and the next legitimate one, for one application row. */
function WorkflowTrail({
  status,
  hasAssessment,
  loanNumber,
}: {
  status: MfApplicationStatus;
  hasAssessment: boolean;
  loanNumber: string | null;
}) {
  const { meaning, nextStep, steps } = describeApplicationWorkflow(
    status,
    hasAssessment,
    loanNumber,
  );
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {steps.map((step) => (
          <span
            key={step.label}
            className={
              step.done
                ? "inline-flex items-center gap-0.5 text-muted-foreground"
                : "inline-flex items-center gap-0.5 text-muted-foreground/50"
            }
          >
            {step.done ? <Check className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {step.label}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{meaning}</p>
      {nextStep && <p className="text-xs font-medium text-foreground">Next: {nextStep}</p>}
    </div>
  );
}

export function ApplicationsPage() {
  const { can, role } = usePermissions();
  // Removing a declined application is an administrator act. The database
  // (`is_org_admin` inside `mf_delete_loan_application`) is the control; this
  // only decides whether to offer the action.
  const isAdmin = role === "owner" || role === "admin";
  const canManage = can("manageApplications");
  const canApprove = can("approveApplications");
  const [status, setStatus] = useState<MfApplicationStatus | "all" | "open">("all");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MfLoanApplication | null>(null);
  const [assessmentTarget, setAssessmentTarget] = useState<MfLoanApplication | null>(null);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [decisionTarget, setDecisionTarget] = useState<MfLoanApplication | null>(null);
  const [decisionMode, setDecisionMode] = useState<"approve" | "reject">("approve");
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [loanApplicationId, setLoanApplicationId] = useState<string | null>(null);
  const [loanOpen, setLoanOpen] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<MfLoanApplication | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MfLoanApplication | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const {
    applications,
    isLoading,
    error,
    createApplication,
    updateApplication,
    transition,
    withdrawApplication,
    deleteApplication,
  } = useMfApplications({ status });
  const { clients } = useMfClients();
  const { products } = useMfLoanProducts({ status: "all" });
  const { versionsById } = useMfProductVersionIndex();
  const { assessedIds } = useMfAssessedApplicationIds();
  // The loan an application has already produced. Loan creation — not a status
  // flip — is what makes an application ready for disbursement, so the row has
  // to know whether that event has happened.
  const { loans, createFromApplication } = useMfLoans({ status: "all" });

  const loanNumberFor = useMemo(() => {
    const map = new Map(
      loans
        .filter((l) => l.application_id)
        .map((l) => [l.application_id as string, l.loan_number]),
    );
    return (applicationId: string) => map.get(applicationId) ?? null;
  }, [loans]);

  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  // The version an application was pinned to at capture time. Repricing the
  // product afterwards must never appear to move an existing application.
  const productLabel = useMemo(() => {
    const map = new Map(products.map((p) => [p.id, p.code]));
    return (id: string) => map.get(id) ?? "—";
  }, [products]);

  const pricedOn = (a: MfLoanApplication) => {
    const version = a.product_version_id ? versionsById.get(a.product_version_id) : undefined;
    return version
      ? `${productLabel(a.product_id)} v${version.version_no}`
      : productLabel(a.product_id);
  };


  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return applications;
    return applications.filter((a) =>
      [a.application_number, a.purpose, clientName(a.client_id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [applications, search, clientName]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openDecision = (application: MfLoanApplication, mode: "approve" | "reject") => {
    setDecisionTarget(application);
    setDecisionMode(mode);
    setDecisionOpen(true);
  };

  const move = (id: string, to: MfApplicationStatus) => {
    transition.mutate({ id, to });
  };

  /**
   * What the menu may offer. These mirror the database rules so the operator is
   * not sent into a refusal — enforcement itself lives in
   * `mf_withdraw_loan_application` and `mf_delete_loan_application`.
   */
  const withdrawable = (a: MfLoanApplication) =>
    !loanNumberFor(a.id) &&
    !["cancelled", "rejected", "disbursed"].includes(a.status);

  const deletable = (a: MfLoanApplication) =>
    !loanNumberFor(a.id) && (a.status === "draft" || a.status === "cancelled");

  const deletionBlockedReason = (a: MfLoanApplication) => {
    if (loanNumberFor(a.id)) return `Part of loan ${loanNumberFor(a.id)} — cannot be deleted`;
    if (a.status === "rejected") return "Declined applications stay on record";
    if (a.status === "disbursed") return "Disbursed — cannot be deleted";
    return "Withdraw it first, then it can be deleted";
  };

  const openLoanCreation = (application: MfLoanApplication) => {
    setLoanApplicationId(application.id);
    setLoanOpen(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Loan applications"
        description="Requested terms, physical assessment and an attributable approval — approval is not disbursement."
        actions={
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              New application
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <Section title="Pipeline" description={`${filtered.length} application(s)`}>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search reference, client or purpose…"
          >
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as MfApplicationStatus | "all" | "open")}
            >
              <SelectTrigger className="h-8 w-[200px] text-sm">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="open">Open pipeline</SelectItem>
                {MF_APPLICATION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {MF_APPLICATION_STATUS_LABELS[s]}
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
              title="No applications yet"
              description="Capture an application for a registered client on an active, priced product."
              action={canManage ? <Button onClick={openCreate}>New application</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Priced on</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setEditing(a);
                      setFormOpen(true);
                    }}
                  >
                    <TableCell className="font-mono text-xs">
                      {a.application_number}
                    </TableCell>
                    <TableCell className="font-medium">{clientName(a.client_id)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {pricedOn(a)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.requested_amount} / {a.requested_term_installments}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.approved_amount != null
                        ? `${a.approved_amount} / ${a.approved_term_installments ?? "—"}`
                        : "—"}
                    </TableCell>
                    <TableCell className="min-w-[280px] space-y-1.5">
                      <StatusBadge tone={STATUS_TONE[a.status]}>
                        {MF_APPLICATION_STATUS_LABELS[a.status]}
                      </StatusBadge>
                      <WorkflowTrail
                        status={a.status}
                        hasAssessment={assessedIds.has(a.id)}
                        loanNumber={loanNumberFor(a.id)}
                      />
                    </TableCell>
                    <TableCell
                      className="space-x-1.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canManage && a.status === "draft" && (
                        <Button size="sm" variant="outline" onClick={() => move(a.id, "submitted")}>
                          Submit
                        </Button>
                      )}
                      {canManage && a.status === "submitted" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => move(a.id, "under_review")}
                        >
                          Start review
                        </Button>
                      )}
                      {canManage && (a.status === "submitted" || a.status === "under_review") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setAssessmentTarget(a);
                            setAssessmentOpen(true);
                          }}
                        >
                          <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
                          Assess
                        </Button>
                      )}
                      {canApprove && a.status === "under_review" && (
                        <>
                          {/* Visible but refused-with-a-reason: the decision guard
                              requires an assessment, so say so instead of letting
                              the operator discover it through a rejection. */}
                          <span title={decisionBlockedReason(a.status, assessedIds.has(a.id)) ?? ""}>
                            <Button
                              size="sm"
                              disabled={!!decisionBlockedReason(a.status, assessedIds.has(a.id))}
                              onClick={() => openDecision(a, "approve")}
                            >
                              Approve
                            </Button>
                          </span>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => openDecision(a, "reject")}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {/* Loan creation is the business event that makes an
                          application ready for disbursement; there is no operator
                          status flip for readiness. */}
                      {canManage &&
                        (a.status === "approved" || a.status === "ready_for_disbursement") &&
                        !loanNumberFor(a.id) && (
                          <Button size="sm" onClick={() => openLoanCreation(a)}>
                            Create loan
                          </Button>
                        )}
                      {loanNumberFor(a.id) && (
                        <span className="text-xs text-muted-foreground">
                          Loan {loanNumberFor(a.id)}
                        </span>
                      )}
                      {canManage && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" aria-label="More actions">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuLabel>{a.application_number}</DropdownMenuLabel>
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing(a);
                                setFormOpen(true);
                              }}
                            >
                              Open
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {/* Lifecycle, not removal: a submitted application that
                                stops proceeding is withdrawn and stays on record. */}
                            {withdrawable(a) ? (
                              <DropdownMenuItem
                                onClick={() => {
                                  setWithdrawTarget(a);
                                  setWithdrawOpen(true);
                                }}
                              >
                                Withdraw…
                              </DropdownMenuItem>
                            ) : null}
                            {/* Removal is only for a record that never became
                                lending history. The database decides; this is a
                                hint, not the control. */}
                            {deletable(a) ? (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                  setDeleteTarget(a);
                                  setDeleteOpen(true);
                                }}
                              >
                                Delete
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem disabled>
                                {deletionBlockedReason(a)}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <ApplicationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        application={editing}
        onCreate={async (input) => {
          await createApplication.mutateAsync(input);
        }}
        onUpdate={async (id, patch) => {
          await updateApplication.mutateAsync({ id, ...patch });
        }}
      />

      <CreateLoanDialog
        open={loanOpen}
        onOpenChange={setLoanOpen}
        presetApplicationId={loanApplicationId}
        onCreate={async (input) => {
          await createFromApplication.mutateAsync({
            applicationId: input.applicationId,
            expectedDisbursementDate: input.expectedDisbursementDate,
            firstInstallmentDate: input.firstInstallmentDate,
          });
        }}
      />

      <AssessmentDialog
        open={assessmentOpen}
        onOpenChange={setAssessmentOpen}
        application={assessmentTarget}
      />

      <WithdrawDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        application={withdrawTarget}
        onWithdraw={async (input) => {
          await withdrawApplication.mutateAsync(input);
        }}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete application"
        description={
          deleteTarget
            ? `Delete ${deleteTarget.application_number} for ${clientName(deleteTarget.client_id)}? It has produced no loan and no financial record, so nothing is lost from the ledger. This cannot be undone.`
            : undefined
        }
        isLoading={deleteApplication.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteApplication.mutate(deleteTarget.id);
        }}
      />

      <DecisionDialog
        open={decisionOpen}
        onOpenChange={setDecisionOpen}
        application={decisionTarget}
        mode={decisionMode}
        onApprove={async (input) => {
          await transition.mutateAsync({
            id: input.id,
            to: "approved",
            approved_amount: input.approved_amount,
            approved_term_installments: input.approved_term_installments,
            decision_notes: input.decision_notes,
          });
        }}
        onReject={async (input) => {
          await transition.mutateAsync({
            id: input.id,
            to: "rejected",
            rejection_reason: input.rejection_reason,
          });
        }}
      />
    </>
  );
}

export default ApplicationsPage;
