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
import { useMemo, useState } from "react";
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
  useStatementDeliveryStatus,
  type StatementDelivery,
} from "@/hooks/useStatementDeliveryStatus";
import { useNetPositionByCurrency } from "@/hooks/useNetPositionByCurrency";
import type { CurrencyNetPositionRow } from "@/services/finance/openItems";

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
  const { formatCurrency } = useCurrency();
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payContactId, setPayContactId] = useState<string | null>(null);

  const contacts = useMemo(() => {
    const rows = (data?.contacts ?? []).filter((c) => filterByBucket(c, bucket));
    const term = search.trim().toLowerCase();
    return term
      ? rows.filter(
          (c) =>
            c.contact_name?.toLowerCase().includes(term) ||
            c.company?.toLowerCase().includes(term) ||
            c.email?.toLowerCase().includes(term),
        )
      : rows;
  }, [data, bucket, search]);

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
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Customer</TableHead>
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
                    <TableCell colSpan={9}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : contacts.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        No customers with outstanding balances.
                      </TableCell>
                    </TableRow>
                  )
                : contacts.map((c) => {
                    const isOpen = expanded === c.contact_id;
                    const isOverdue = (c.buckets.days90 ?? 0) > 0.01;
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
                            <TableCell colSpan={9} className="py-3">
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
    <Badge variant="secondary" className="gap-1" title="Queued for delivery">
      <Clock className="h-3 w-3" />
      {delivery.state === "sending" ? "Sending" : "Queued"}
    </Badge>
  );
}
