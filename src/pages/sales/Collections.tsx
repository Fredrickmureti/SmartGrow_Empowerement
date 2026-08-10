/**
 * Collections Workspace (ADR 0027 follow-up).
 *
 * Turns the existing aging-report data + canonical customer ledger
 * (`useAgingReport` + `useCustomerLedger`) into an actionable AR
 * collections cockpit. Each row is one customer with outstanding
 * receivables; expand for invoice-level detail; per-row actions
 * jump into the existing record-payment / customer-ledger /
 * customer-statements flows — no shadow data, no duplicate state.
 */
import { useMemo, useState, useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAgingReport, type AgingContactDetail } from "@/hooks/useAgingReport";
import { useCurrency } from "@/hooks/useCurrency";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Clock,
  Mail,
  MailCheck,
  MailX,
  Receipt,
  Search,
  Wallet,
} from "lucide-react";
import { RecordCustomerPaymentDialog as RecordPaymentDialog } from "@/components/payments/RecordCustomerPaymentDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useStatementDeliveryStatus,
  type StatementDelivery,
} from "@/hooks/useStatementDeliveryStatus";
import type { CollectorAssignment } from "@/services/finance/collectorAssignments";
import { useNetPositionByCurrency } from "@/hooks/useNetPositionByCurrency";
import { useCollectorAssignments } from "@/hooks/useCollectorAssignments";
import { useDunningAssignments } from "@/hooks/useDunningAssignments";
import {
  DUNNING_ACTION_LABELS,
  type DunningAssignmentRow,
} from "@/services/finance/dunning";
import type { CurrencyNetPositionRow } from "@/services/finance/openItems";
import { UserCog, Check } from "lucide-react";

import {
  AGING_BUCKET_LABELS,
  AGING_BUCKET_SHORT_LABELS,
  type AgingBucketKey,
} from "@/services/finance/aging";

/**
 * Bucket vocabulary is the canonical one owned by SQL — `not_due`, then
 * 0-30 / 31-60 / 61-90 / 90+ days past due. `in_credit` is not an aging
 * bucket: it isolates customers whose net position is a credit (unapplied
 * receipts or credit notes exceed their open invoices).
 */
type Bucket = "all" | "in_credit" | AgingBucketKey;

const BUCKET_LABELS = AGING_BUCKET_LABELS;

function filterByBucket(c: AgingContactDetail, bucket: Bucket): boolean {
  if (bucket === "all") return c.buckets.total > 0.01;
  if (bucket === "in_credit") return c.buckets.total < -0.01;
  return (c.buckets[bucket] ?? 0) > 0.01;
}


export default function Collections() {
  const { data, isLoading } = useAgingReport({ reportType: "ar" });
  const { data: delivery } = useStatementDeliveryStatus();
  const { data: currencyPositions } = useNetPositionByCurrency();
  const { assignments, members, currentUserId, assign, unassign } = useCollectorAssignments();
  const { data: dunning } = useDunningAssignments();
  const { formatCurrency } = useCurrency();
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payContactId, setPayContactId] = useState<string | null>(null);
  const [myAccountsOnly, setMyAccountsOnly] = useState(false);
  const [assignDialogContact, setAssignDialogContact] = useState<string | null>(null);

  const contacts = useMemo(() => {
    let rows = (data?.contacts ?? []).filter((c) => filterByBucket(c, bucket));
    // "My accounts" — only contacts assigned to the current user.
    if (myAccountsOnly && currentUserId) {
      rows = rows.filter(
        (c) => assignments[c.contact_id]?.collectorUserId === currentUserId,
      );
    }
    const term = search.trim().toLowerCase();
    rows = term
      ? rows.filter(
          (c) =>
            c.contact_name?.toLowerCase().includes(term) ||
            c.company?.toLowerCase().includes(term) ||
            c.email?.toLowerCase().includes(term),
        )
      : rows;
    return rows;
  }, [data, bucket, search, myAccountsOnly, currentUserId, assignments]);

  const summary = data?.summary;
  // Net AR position: open residuals less unapplied customer credit (the aging
  // RPC returns credit rows with a negative residual).
  const totalAR = summary?.total ?? 0;
  // Overdue = every bucket except `not_due`. `current` is 0-30 days PAST DUE,
  // so excluding it (the old behaviour) understated overdue exposure.
  const overdueTotal =
    (summary?.current ?? 0) +
    (summary?.days30 ?? 0) +
    (summary?.days60 ?? 0) +
    (summary?.days90 ?? 0);
  const notDueTotal = summary?.not_due ?? 0;
  const pctOverdue = totalAR > 0 ? Math.round((overdueTotal / totalAR) * 100) : 0;
  const customers90Plus = (data?.contacts ?? []).filter(
    (c) => (c.buckets.days90 ?? 0) > 0.01,
  ).length;
  const customersInCredit = (data?.contacts ?? []).filter(
    (c) => (c.buckets.total ?? 0) < -0.01,
  ).length;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Collections</h1>
          <p className="text-muted-foreground text-sm">
            Customers with outstanding receivables. Action each row in
            place — record payment, open ledger, send a statement.
          </p>
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Net AR" value={formatCurrency(totalAR)} />
        <KpiCard label="Not yet due" value={formatCurrency(notDueTotal)} />
        <KpiCard label="Overdue" value={formatCurrency(overdueTotal)} accent />
        <KpiCard label="% Overdue" value={`${pctOverdue}%`} />
        <KpiCard label="Customers 90+ days" value={String(customers90Plus)} />
      </div>

      {/* Filters */}
      <Card className="p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search customer, company, email…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={bucket} onValueChange={(v) => setBucket(v as Bucket)}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outstanding</SelectItem>
            <SelectItem value="not_due">{BUCKET_LABELS.not_due}</SelectItem>
            <SelectItem value="current">{BUCKET_LABELS.current}</SelectItem>
            <SelectItem value="days30">{BUCKET_LABELS.days30}</SelectItem>
            <SelectItem value="days60">{BUCKET_LABELS.days60}</SelectItem>
            <SelectItem value="days90">{BUCKET_LABELS.days90}</SelectItem>
            <SelectItem value="in_credit">
              In credit{customersInCredit > 0 ? ` (${customersInCredit})` : ""}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={myAccountsOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setMyAccountsOnly((v) => !v)}
          title="Show only accounts assigned to me"
        >
          <UserCog className="h-4 w-4 mr-1.5" />
          My accounts
        </Button>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Customer</TableHead>
              <TableHead>Collector</TableHead>
              <TableHead>Next action</TableHead>
              <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.not_due}</TableHead>
              <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.current}</TableHead>
              <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days30}</TableHead>
              <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days60}</TableHead>
              <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days90}</TableHead>
              <TableHead className="text-right">Net outstanding</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={11}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : contacts.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                        No customers with outstanding balances.
                      </TableCell>
                    </TableRow>
                  )
                : contacts.map((c) => {
                    const isOpen = expanded === c.contact_id;
                    const isOverdue = (c.buckets.days90 ?? 0) > 0.01;
                    const assignment = assignments[c.contact_id];
                    return (
                      <>
                        <TableRow key={c.contact_id} className="hover:bg-muted/40">
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setExpanded(isOpen ? null : c.contact_id)}
                              aria-label="Toggle details"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium flex items-center gap-2">
                              {c.contact_name}
                              {isOverdue && (
                                <Badge variant="destructive" className="gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  90+
                                </Badge>
                              )}
                              {(c.buckets.total ?? 0) < -0.01 && (
                                <Badge variant="secondary">In credit</Badge>
                              )}
                              <DeliveryBadge delivery={delivery?.[c.contact_id]} />
                            </div>
                            {c.company && (
                              <div className="text-xs text-muted-foreground">{c.company}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <CollectorCell
                              contactId={c.contact_id}
                              assignment={assignment}
                              onAssign={() => setAssignDialogContact(c.contact_id)}
                              onUnassign={() => unassign(c.contact_id)}
                            />
                          </TableCell>
                          <TableCell>
                            <NextActionCell row={dunning?.[c.contact_id]} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(c.buckets.not_due ?? 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(c.buckets.current ?? 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(c.buckets.days30 ?? 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(c.buckets.days60 ?? 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-destructive">
                            {formatCurrency(c.buckets.days90 ?? 0)}

                          </TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">
                            {formatCurrency(c.buckets.total ?? 0)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPayContactId(c.contact_id)}
                                title="Record payment"
                              >
                                <Receipt className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                asChild
                                title="Open ledger"
                              >
                                <Link to={`/sales/customers/${c.contact_id}/ledger`}>
                                  <Wallet className="h-4 w-4" />
                                </Link>
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                asChild
                                title="Send statement"
                              >
                                <Link
                                  to={`/sales/statements?contact_id=${c.contact_id}`}
                                >
                                  <Mail className="h-4 w-4" />
                                </Link>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow key={`${c.contact_id}-detail`} className="bg-muted/20">
                            <TableCell colSpan={11} className="py-3">
                              <div className="px-6 space-y-2">
                                <div className="flex items-center justify-between">
                                  <h4 className="font-medium text-sm">Open documents</h4>
                                  <Link
                                    to={`/sales/customers/${c.contact_id}/ledger`}
                                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                                  >
                                    Full ledger <ArrowUpRight className="h-3 w-3" />
                                  </Link>
                                </div>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Document</TableHead>
                                      <TableHead>Issued</TableHead>
                                      <TableHead>Due</TableHead>
                                      <TableHead className="text-right">Total</TableHead>
                                      <TableHead className="text-right">Paid</TableHead>
                                      <TableHead className="text-right">Outstanding</TableHead>
                                      <TableHead className="text-right">Days</TableHead>
                                      <TableHead>Bucket</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {c.documents.map((d) => (
                                      <TableRow key={d.id}>
                                        <TableCell>{d.document_number}</TableCell>
                                        <TableCell>{d.document_date}</TableCell>
                                        <TableCell>{d.due_date}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatCurrency(d.total)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatCurrency(d.amount_paid)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums font-medium">
                                          {formatCurrency(d.balance_due)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {d.days_overdue > 0 ? d.days_overdue : "—"}
                                        </TableCell>
                                        <TableCell>
                                          <Badge variant="secondary">
                                            {BUCKET_LABELS[
                                              d.bucket as keyof typeof BUCKET_LABELS
                                            ] ?? d.bucket}
                                          </Badge>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>

                                {/* Per-currency net position breakdown */}
                                {(currencyPositions?.[c.contact_id]?.length ?? 0) > 1 && (
                                  <CurrencyBreakdown
                                    rows={currencyPositions[c.contact_id]}
                                    formatCurrency={formatCurrency}
                                  />
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
          </TableBody>
        </Table>
      </Card>

      <RecordPaymentDialog
        open={!!payContactId}
        onOpenChange={(v) => !v && setPayContactId(null)}
        preSelectedContactId={payContactId ?? undefined}
      />

      <AssignCollectorDialog
        open={!!assignDialogContact}
        onOpenChange={(v) => !v && setAssignDialogContact(null)}
        contactId={assignDialogContact}
        members={members}
        currentAssignment={assignDialogContact ? assignments[assignDialogContact] : undefined}
        onAssign={(userId) => assign(assignDialogContact!, userId)}
        onUnassign={() => assignDialogContact && unassign(assignDialogContact)}
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-2xl font-semibold mt-1 ${accent ? "text-destructive" : ""}`}
      >
        {value}
      </div>
    </Card>
  );
}

/**
 * Per-currency net position breakdown for a customer who owes in more than one
 * currency. Document-currency amounts are labelled with their ISO code so a
 * collector can distinguish KES exposure from USD exposure at a glance.
 */
function CurrencyBreakdown({
  rows,
  formatCurrency,
}: {
  rows: CurrencyNetPositionRow[];
  formatCurrency: (amount: number, currencyCode?: string) => string;
}) {
  return (
    <div className="mt-3 border-t pt-3">
      <h4 className="font-medium text-sm mb-2">By currency</h4>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Currency</TableHead>
            <TableHead className="text-right">Open</TableHead>
            <TableHead className="text-right">Credit</TableHead>
            <TableHead className="text-right">Net (doc ccy)</TableHead>
            <TableHead className="text-right">Net (base)</TableHead>
            <TableHead className="text-right">{AGING_BUCKET_SHORT_LABELS.days90}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.currency}>
              <TableCell className="font-mono text-xs">{r.currency}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(r.openAmount, r.currency)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(r.creditAmount, r.currency)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatCurrency(r.netAmount, r.currency)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatCurrency(r.baseNetAmount)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-destructive">
                {formatCurrency(r.days90, r.currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Last statement/reminder delivery outcome for this customer. A collector must
 * be able to see "reminder bounced" without leaving the page — a chase that was
 * never delivered is not a chase.
 */
function DeliveryBadge({ delivery }: { delivery?: StatementDelivery }) {
  if (!delivery) return null;
  if (delivery.state === "sent") {
    return (
      <Badge variant="outline" className="gap-1" title={`Statement sent ${delivery.at ?? ""}`}>
        <MailCheck className="h-3 w-3" />
        Sent
      </Badge>
    );
  }
  if (delivery.state === "failed") {
    return (
      <Badge
        variant="destructive"
        className="gap-1"
        title={delivery.lastError ?? "Delivery failed"}
      >
        <MailX className="h-3 w-3" />
        Send failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1" title="Delivery queued">
      <MailCheck className="h-3 w-3" />
      Queued
    </Badge>
  );
}

/**
 * Next-action cell — renders the escalation step the server assigned to this
 * customer via `dunning_assignment`. The label is policy-driven; the browser
 * never decides which dunning level applies.
 */
function NextActionCell({ row }: { row?: DunningAssignmentRow }) {
  if (!row?.nextAction) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col">
      <span className="text-sm">{DUNNING_ACTION_LABELS[row.nextAction]}</span>
      {row.dunningLevelName && (
        <span className="text-xs text-muted-foreground">{row.dunningLevelName}</span>
      )}
    </div>
  );
}

/**
 * Collector cell — shows the assigned collector's name or an "Assign" link.
 */
function CollectorCell({
  contactId,
  assignment,
  onAssign,
  onUnassign,
}: {
  contactId: string;
  assignment?: CollectorAssignment;
  onAssign: () => void;
  onUnassign: () => void;
}) {
  if (assignment) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-sm">{assignment.collectorName}</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground underline"
          onClick={onAssign}
        >
          Change
        </button>
      </div>
    );
  }
  return (
    <button
      className="text-sm text-primary hover:underline inline-flex items-center gap-1"
      onClick={onAssign}
    >
      <UserCog className="h-3.5 w-3.5" />
      Assign
    </button>
  );
}

/**
 * Dialog to assign or reassign a collector to a customer.
 */
function AssignCollectorDialog({
  open,
  onOpenChange,
  contactId,
  members,
  currentAssignment,
  onAssign,
  onUnassign,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string | null;
  members: { userId: string; fullName: string; email: string }[];
  currentAssignment?: CollectorAssignment;
  onAssign: (userId: string) => void;
  onUnassign: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(currentAssignment?.collectorUserId ?? null);
      setSubmitting(false);
    }
  }, [open, currentAssignment?.collectorUserId]);

  const handleAssign = useCallback(async () => {
    if (!contactId || !selected) return;
    setSubmitting(true);
    try {
      await onAssign(selected);
      onOpenChange(false);
    } catch {
      setSubmitting(false);
    }
  }, [contactId, selected, onAssign, onOpenChange]);

  const handleUnassign = useCallback(async () => {
    if (!contactId) return;
    setSubmitting(true);
    try {
      await onUnassign();
      onOpenChange(false);
    } catch {
      setSubmitting(false);
    }
  }, [contactId, onUnassign, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Assign collector</DialogTitle>
          <DialogDescription>
            Choose the team member responsible for collecting this customer's
            outstanding receivables.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-[300px] overflow-y-auto py-2">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active organization members found.
            </p>
          ) : (
            members.map((m) => (
              <button
                key={m.userId}
                onClick={() => setSelected(m.userId)}
                className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected === m.userId
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/40"
                }`}
              >
                <div className="flex-1">
                  <div className="font-medium">{m.fullName}</div>
                  <div className="text-xs text-muted-foreground">{m.email}</div>
                </div>
                {selected === m.userId && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))
          )}
        </div>

        <DialogFooter className="gap-2">
          {currentAssignment && (
            <Button
              variant="outline"
              onClick={handleUnassign}
              disabled={submitting}
            >
              Unassign
            </Button>
          )}
          <Button
            onClick={handleAssign}
            disabled={!selected || submitting}
          >
            {submitting ? "Saving…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
