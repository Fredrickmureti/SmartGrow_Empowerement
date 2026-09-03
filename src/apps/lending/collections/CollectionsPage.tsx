/**
 * Lending → Collections (C7b).
 *
 * Arrears, days past due and PAR are read straight from the server-derived
 * `mf_loan_balances`, `mf_loan_arrears` and `mf_par_summary` views. The page
 * only groups and presents; it never derives an authoritative financial figure.
 * Collection activities are append-only business events.
 */
import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMfClients } from "@/hooks/useMfClients";
import { useMfLoanBalances, type MfLoanBalance } from "@/hooks/useMfRepayments";
import {
  MF_ACTIVITY_TYPES,
  useMfArrears,
  useMfCollectionActivities,
  useMfParSummary,
} from "@/hooks/useMfCollections";
import { LogActivityDialog } from "./LogActivityDialog";

const BUCKETS = [
  { key: "current", label: "Current", test: (d: number) => d <= 0 },
  { key: "1-30", label: "1–30 days", test: (d: number) => d >= 1 && d <= 30 },
  { key: "31-60", label: "31–60 days", test: (d: number) => d >= 31 && d <= 60 },
  { key: "61-90", label: "61–90 days", test: (d: number) => d >= 61 && d <= 90 },
  { key: "90+", label: "90+ days", test: (d: number) => d > 90 },
] as const;

const money = (value: number) =>
  Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const activityLabel = (value: string) =>
  MF_ACTIVITY_TYPES.find((t) => t.value === value)?.label ?? value;

function tone(dpd: number): "success" | "warning" | "danger" {
  if (dpd <= 0) return "success";
  if (dpd <= 30) return "warning";
  return "danger";
}

type WorklistLoan = {
  loan_id: string;
  client_id: string;
  branch_id: string | null;
  loan_number: string;
};

export function CollectionsPage() {
  const { can } = usePermissions();
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<string>("all");
  const [activityLoan, setActivityLoan] = useState<WorklistLoan | null>(null);

  const { balances, isLoading, error } = useMfLoanBalances();
  const { clients } = useMfClients();
  const { arrears, isLoading: arrearsLoading, error: arrearsError } = useMfArrears();
  const { par } = useMfParSummary();
  const { activities, isLoading: activitiesLoading } = useMfCollectionActivities();

  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  const active = useMemo(
    () => balances.filter((b) => b.status === "active"),
    [balances],
  );

  // Portfolio-at-risk comes from the server view; the page only totals the rows
  // the caller is allowed to see.
  const portfolio = useMemo(() => {
    const outstanding = par.reduce((s, r) => s + Number(r.portfolio_outstanding ?? 0), 0);
    const atRisk30 = par.reduce((s, r) => s + Number(r.par_30 ?? 0), 0);
    const overdue = active.reduce((s, b) => s + Number(b.amount_overdue ?? 0), 0);
    return {
      outstanding,
      overdue,
      par30: outstanding > 0 ? (atRisk30 / outstanding) * 100 : 0,
      inArrears: active.filter((b) => Number(b.amount_overdue ?? 0) > 0).length,
    };
  }, [par, active]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rule = BUCKETS.find((b) => b.key === bucket);
    return active.filter((b: MfLoanBalance) => {
      if (rule && !rule.test(Number(b.days_past_due ?? 0))) return false;
      if (!q) return true;
      return [b.loan_number, clientName(b.client_id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [active, bucket, search, clientName]);

  const overdueInstallments = useMemo(
    () => arrears.filter((a) => Number(a.arrears_amount ?? 0) > 0.005),
    [arrears],
  );

  const stats: Array<{ label: string; value: string }> = [
    { label: "Outstanding portfolio", value: money(portfolio.outstanding) },
    { label: "Amount overdue", value: money(portfolio.overdue) },
    { label: "PAR > 30 days", value: `${portfolio.par30.toFixed(1)}%` },
    { label: "Loans in arrears", value: String(portfolio.inArrears) },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Collections"
        description="Arrears, days past due and portfolio at risk, derived from the contractual schedule against posted payments."
      />
      <PageBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <Card key={s.label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="worklist">
          <TabsList>
            <TabsTrigger value="worklist">Worklist</TabsTrigger>
            <TabsTrigger value="installments">Overdue installments</TabsTrigger>
            <TabsTrigger value="activity">Activity log</TabsTrigger>
          </TabsList>

          <TabsContent value="worklist">
            <Section title="Portfolio" description={`${filtered.length} active loan(s)`}>
              <FilterBar
                search={search}
                onSearchChange={setSearch}
                placeholder="Search loan or client…"
              >
                <Select value={bucket} onValueChange={setBucket}>
                  <SelectTrigger className="h-8 w-[180px] text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ageing buckets</SelectItem>
                    {BUCKETS.map((b) => (
                      <SelectItem key={b.key} value={b.key}>
                        {b.label}
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
                  title="Nothing to collect"
                  description="No active loans match this filter."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Loan</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Overdue</TableHead>
                      <TableHead className="text-right">DPD</TableHead>
                      <TableHead>Next due</TableHead>
                      <TableHead>Ageing</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((b) => {
                      const dpd = Number(b.days_past_due ?? 0);
                      return (
                        <TableRow key={b.loan_id}>
                          <TableCell className="font-mono text-xs">{b.loan_number}</TableCell>
                          <TableCell className="font-medium">{clientName(b.client_id)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {b.currency_code} {money(b.total_outstanding)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(b.amount_overdue)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{dpd}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {b.next_due_date ?? "—"}
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone={tone(dpd)}>
                              {BUCKETS.find((x) => x.test(dpd))?.label ?? "Current"}
                            </StatusBadge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setActivityLoan({
                                  loan_id: b.loan_id,
                                  client_id: b.client_id,
                                  branch_id: b.branch_id,
                                  loan_number: b.loan_number,
                                })
                              }
                            >
                              Log activity
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="installments">
            <Section
              title="Overdue installments"
              description={`${overdueInstallments.length} installment(s) past due`}
            >
              {arrearsError ? (
                <ErrorState description={arrearsError.message} />
              ) : arrearsLoading ? (
                <LoadingState />
              ) : overdueInstallments.length === 0 ? (
                <EmptyState
                  title="No overdue installments"
                  description="Every installment due to date has been settled."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Loan</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead className="text-right">#</TableHead>
                      <TableHead>Due date</TableHead>
                      <TableHead className="text-right">Due</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Arrears</TableHead>
                      <TableHead className="text-right">DPD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overdueInstallments.map((a) => (
                      <TableRow key={`${a.loan_id}-${a.installment_no}`}>
                        <TableCell className="font-mono text-xs">{a.loan_number}</TableCell>
                        <TableCell className="font-medium">{clientName(a.client_id)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.installment_no}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {a.due_date}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(a.total_due)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(a.total_paid)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {money(a.arrears_amount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.days_past_due}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="activity">
            <Section
              title="Collection activity"
              description="Append-only record of calls, visits, promises and outcomes."
            >
              {activitiesLoading ? (
                <LoadingState />
              ) : activities.length === 0 ? (
                <EmptyState
                  title="No activity recorded"
                  description="Log a call or visit from the worklist to start the collection history."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Activity</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="text-right">Promised</TableHead>
                      <TableHead>Promise date</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activities.map((a) => (
                      <TableRow key={a.id} className={a.cancelled_at ? "opacity-50" : undefined}>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(a.activity_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-medium">{clientName(a.client_id)}</TableCell>
                        <TableCell>{activityLabel(a.activity_type)}</TableCell>
                        <TableCell>
                          {a.cancelled_at ? (
                            <StatusBadge tone="danger">Cancelled</StatusBadge>
                          ) : (
                            <span className="text-sm">{a.outcome ?? "—"}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.promise_amount ? money(a.promise_amount) : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {a.promise_date ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-[24rem] truncate text-sm text-muted-foreground">
                          {a.notes ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </TabsContent>
        </Tabs>
      </PageBody>

      <LogActivityDialog
        open={!!activityLoan}
        onOpenChange={(open) => !open && setActivityLoan(null)}
        loan={activityLoan}
      />
    </>
  );
}

