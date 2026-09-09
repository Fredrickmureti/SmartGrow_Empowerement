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
import { ClipboardCheck, Plus } from "lucide-react";
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
  MF_APPLICATION_STATUSES,
  MF_APPLICATION_STATUS_LABELS,
  useMfApplications,
  type MfApplicationStatus,
  type MfLoanApplication,
} from "@/hooks/useMfApplications";
import { ApplicationFormDialog } from "./ApplicationFormDialog";
import { AssessmentDialog } from "./AssessmentDialog";
import { DecisionDialog } from "./DecisionDialog";

const STATUS_TONE: Record<
  MfApplicationStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  under_review: "warning",
  approved: "success",
  rejected: "danger",
  ready_for_disbursement: "success",
  cancelled: "neutral",
};

export function ApplicationsPage() {
  const { can } = usePermissions();
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

  const {
    applications,
    isLoading,
    error,
    createApplication,
    updateApplication,
    transition,
  } = useMfApplications({ status });
  const { clients } = useMfClients();

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
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[a.status]}>
                        {MF_APPLICATION_STATUS_LABELS[a.status]}
                      </StatusBadge>
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
                          <Button size="sm" onClick={() => openDecision(a, "approve")}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => openDecision(a, "reject")}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {canManage && a.status === "approved" && (
                        <Button
                          size="sm"
                          onClick={() => move(a.id, "ready_for_disbursement")}
                        >
                          Mark ready
                        </Button>
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

      <AssessmentDialog
        open={assessmentOpen}
        onOpenChange={setAssessmentOpen}
        application={assessmentTarget}
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
