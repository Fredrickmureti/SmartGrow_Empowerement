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
import { usePromisesToPay } from "@/hooks/usePromisesToPay";
import { useArDisputes } from "@/hooks/useArDisputes";
import {
  DISPUTE_TYPES,
  DISPUTE_TYPE_LABELS,
  type DisputeType,
} from "@/services/finance/disputes";
import { useCollectionsWorkQueue } from "@/hooks/useCollectionsWorkQueue";
import type { WorkQueueRow } from "@/services/finance/collectionsWorkQueue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldAlert } from "lucide-react";
import type { PromiseToPay } from "@/services/finance/promises";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { HandCoins } from "lucide-react";
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
  const {
    data: promises,
    record: recordPromise,
    cancel: cancelPromise,
  } = usePromisesToPay();
  const {
    data: disputes,
    raise: raiseDispute,
    resolve: resolveDispute,
    totalDisputed,
  } = useArDisputes();
  const { formatCurrency } = useCurrency();
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payContactId, setPayContactId] = useState<string | null>(null);
  const [myAccountsOnly, setMyAccountsOnly] = useState(false);
  const [assignDialogContact, setAssignDialogContact] = useState<string | null>(null);
  const [promiseDialogContact, setPromiseDialogContact] = useState<string | null>(null);
  const [disputeDialogContact, setDisputeDialogContact] = useState<string | null>(null);

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
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <KpiCard label="Net AR" value={formatCurrency(totalAR)} />
        <KpiCard label="Not yet due" value={formatCurrency(notDueTotal)} />
        <KpiCard label="Overdue" value={formatCurrency(overdueTotal)} accent />
        <KpiCard label="% Overdue" value={`${pctOverdue}%`} />
        <KpiCard label="Customers 90+ days" value={String(customers90Plus)} />
        {/* Disputed exposure is reported beside AR, never subtracted from it. */}
        <KpiCard label="Disputed" value={formatCurrency(totalDisputed)} />
      </div>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">Customer list</TabsTrigger>
          <TabsTrigger value="queue">Work queue</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="space-y-4">
          <WorkQueuePanel
            formatCurrency={formatCurrency}
            currentUserId={currentUserId}
            onRecordPayment={setPayContactId}
            onRecordPromise={setPromiseDialogContact}
          />
        </TabsContent>

        <TabsContent value="list" className="space-y-4">
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
              <TableHead>Promise</TableHead>
              <TableHead>Dispute</TableHead>
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
                    <TableCell colSpan={13}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : contacts.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={13} className="text-center text-muted-foreground py-8">
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
                          <TableCell>
                            <DisputeCell
                              summary={disputes?.[c.contact_id]}
                              formatCurrency={formatCurrency}
                              onResolve={resolveDispute}
                            />
                          </TableCell>
                          <TableCell>
                            <PromiseCell
                              promise={promises?.[c.contact_id]}
                              formatCurrency={formatCurrency}
                              onCancel={cancelPromise}
                            />
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
                                onClick={() => setPromiseDialogContact(c.contact_id)}
                                title="Record promise to pay"
                              >
                                <HandCoins className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDisputeDialogContact(c.contact_id)}
                                title="Flag dispute"
                              >
                                <ShieldAlert className="h-4 w-4" />
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
                            <TableCell colSpan={13} className="py-3">
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
        </TabsContent>
      </Tabs>

      <RecordPaymentDialog
        open={!!payContactId}
        onOpenChange={(v) => !v && setPayContactId(null)}
        preSelectedContactId={payContactId ?? undefined}
      />

      <PromiseToPayDialog
        open={!!promiseDialogContact}
        onOpenChange={(v) => !v && setPromiseDialogContact(null)}
        contactId={promiseDialogContact}
        onRecord={recordPromise}
      />

      <RaiseDisputeDialog
        open={!!disputeDialogContact}
        onOpenChange={(v) => !v && setDisputeDialogContact(null)}
        contactId={disputeDialogContact}
        onRaise={raiseDispute}
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
 * Work queue — the prioritised action list. Ranking, exposure and the
 * dispute/promise de-prioritisation are all computed by SQL
 * (`collections_work_queue`); this panel only renders and filters by owner.
 */
function WorkQueuePanel({
  formatCurrency,
  currentUserId,
  onRecordPayment,
  onRecordPromise,
}: {
  formatCurrency: (v: number) => string;
  currentUserId: string | null;
  onRecordPayment: (contactId: string) => void;
  onRecordPromise: (contactId: string) => void;
}) {
  const [mineOnly, setMineOnly] = useState(false);
  const { data, isLoading } = useCollectionsWorkQueue(
    mineOnly ? currentUserId : null,
  );

  return (
    <>
      <Card className="p-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground flex-1 min-w-[220px]">
          Ranked by exposure and age. Accounts in dispute or under an open
          promise are de-prioritised, not hidden.
        </p>
        <Button
          variant={mineOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setMineOnly((v) => !v)}
        >
          <UserCog className="h-4 w-4 mr-1.5" />
          My accounts
        </Button>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-right">#</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Next action</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Days overdue</TableHead>
              <TableHead className="text-right">Net outstanding</TableHead>
              <TableHead className="text-right">Priority</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  Nothing to chase — the queue is clear.
                </TableCell>
              </TableRow>
            ) : (
              data.map((row: WorkQueueRow, i: number) => (
                <TableRow key={row.contactId} className="hover:bg-muted/40">
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {i + 1}
                  </TableCell>
                  <TableCell className="font-medium">{row.contactName ?? "—"}</TableCell>
                  <TableCell>
                    {row.nextAction ? (
                      <span className="text-sm">
                        {DUNNING_ACTION_LABELS[row.nextAction]}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                    {row.dunningLevelName && (
                      <div className="text-xs text-muted-foreground">
                        {row.dunningLevelName}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.inDispute && (
                        <Badge variant="destructive" className="gap-1">
                          <ShieldAlert className="h-3 w-3" />
                          {formatCurrency(row.disputedAmount)}
                        </Badge>
                      )}
                      {row.inPromise && (
                        <Badge variant="secondary" className="gap-1">
                          <HandCoins className="h-3 w-3" />
                          {row.expectedPaymentDate}
                        </Badge>
                      )}
                      {!row.inDispute && !row.inPromise && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.maxDaysOverdue > 0 ? row.maxDaysOverdue : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">
                    {formatCurrency(row.netAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {Math.round(row.priorityScore).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onRecordPayment(row.contactId)}
                        title="Record payment"
                      >
                        <Receipt className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onRecordPromise(row.contactId)}
                        title="Record promise to pay"
                      >
                        <HandCoins className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="outline" asChild title="Open ledger">
                        <Link to={`/sales/customers/${row.contactId}/ledger`}>
                          <Wallet className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

/**
 * Dispute cell — open contested exposure for the customer. The amount is
 * reported, never netted off the receivable.
 */
function DisputeCell({
  summary,
  formatCurrency,
  onResolve,
}: {
  summary?: { count: number; baseAmount: number; first: { id: string } };
  formatCurrency: (v: number) => string;
  onResolve: (
    id: string,
    status: "resolved" | "rejected",
    note?: string | null,
  ) => Promise<void> | void;
}) {
  if (!summary) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Badge variant="destructive" className="gap-1 w-fit">
        <ShieldAlert className="h-3 w-3" />
        {formatCurrency(summary.baseAmount)}
      </Badge>
      {summary.count > 1 && (
        <span className="text-xs text-muted-foreground">
          {summary.count} disputes
        </span>
      )}
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline text-left"
        onClick={() => void onResolve(summary.first.id, "resolved")}
      >
        Resolve
      </button>
    </div>
  );
}

/** Flags a contested amount. Never changes the receivable itself. */
function RaiseDisputeDialog({
  open,
  onOpenChange,
  contactId,
  onRaise,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string | null;
  onRaise: (input: {
    contactId: string;
    amountDisputed: number;
    disputeType: string;
    reason?: string | null;
  }) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<DisputeType>("other");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount("");
      setType("other");
      setReason("");
    }
  }, [open]);

  const submit = async () => {
    if (!contactId) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the disputed amount");
      return;
    }
    setSaving(true);
    try {
      await onRaise({
        contactId,
        amountDisputed: value,
        disputeType: type,
        reason: reason.trim() || null,
      });
      toast.success("Dispute flagged");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Could not flag the dispute");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag a dispute</DialogTitle>
          <DialogDescription>
            Records a contested amount. The receivable is unchanged — disputed
            exposure is reported separately and pauses dunning escalation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="disp-amount">Disputed amount</Label>
            <Input
              id="disp-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Dispute type</Label>
            <Select value={type} onValueChange={(v) => setType(v as DisputeType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISPUTE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DISPUTE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="disp-reason">Reason</Label>
            <Textarea
              id="disp-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What is the customer contesting?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Flag dispute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Promise cell — the customer's earliest open commitment. Amounts are shown in
 * the promise's own currency; kept/broken transitions are decided server-side.
 */
function PromiseCell({
  promise,
  formatCurrency,
  onCancel,
}: {
  promise?: PromiseToPay;
  formatCurrency: (v: number) => string;
  onCancel: (id: string) => Promise<void> | void;
}) {
  if (!promise) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const overdue = promise.expectedPaymentDate < new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm tabular-nums">
        {formatCurrency(promise.promisedAmount)}
      </span>
      <span
        className={`text-xs ${overdue ? "text-destructive" : "text-muted-foreground"}`}
      >
        by {promise.expectedPaymentDate}
      </span>
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline text-left"
        onClick={() => void onCancel(promise.id)}
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * Records a promise to pay. The dialog only captures intent — the server
 * resolves org, base-currency value and idempotency.
 */
function PromiseToPayDialog({
  open,
  onOpenChange,
  contactId,
  onRecord,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string | null;
  onRecord: (input: {
    contactId: string;
    promisedAmount: number;
    expectedPaymentDate: string;
    notes?: string | null;
  }) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount("");
      setDate("");
      setNotes("");
    }
  }, [open]);

  const submit = async () => {
    if (!contactId) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a promised amount greater than zero");
      return;
    }
    if (!date) {
      toast.error("Choose the date the customer promised to pay");
      return;
    }
    setSaving(true);
    try {
      await onRecord({
        contactId,
        promisedAmount: value,
        expectedPaymentDate: date,
        notes: notes.trim() || null,
      });
      toast.success("Promise to pay recorded");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message || "Could not record the promise");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record promise to pay</DialogTitle>
          <DialogDescription>
            Log the amount and date the customer committed to. This does not
            post any money — it is tracked against their outstanding balance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ptp-amount">Promised amount</Label>
            <Input
              id="ptp-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ptp-date">Expected payment date</Label>
            <Input
              id="ptp-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ptp-notes">Notes</Label>
            <Textarea
              id="ptp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was agreed on the call?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Record promise"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
