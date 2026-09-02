/**
 * Lending → Collections (C7b).
 *
 * Arrears, days past due and PAR are read straight from the server-derived
 * `mf_loan_balances`, `mf_loan_arrears` and `mf_par_summary` views. The page
 * only groups and presents; it never derives an authoritative financial figure.
 * Collection activities are append-only business events.
 */
import { useMemo, useState } from "react";
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


export function CollectionsPage() {
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<string>("all");

  const { balances, isLoading, error } = useMfLoanBalances();
  const { clients } = useMfClients();

  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  const active = useMemo(
    () => balances.filter((b) => b.status === "active"),
    [balances],
  );

  const portfolio = useMemo(() => {
    const outstanding = active.reduce((s, b) => s + Number(b.total_outstanding ?? 0), 0);
    const atRisk = active
      .filter((b) => Number(b.days_past_due ?? 0) > 30)
      .reduce((s, b) => s + Number(b.total_outstanding ?? 0), 0);
    const overdue = active.reduce((s, b) => s + Number(b.amount_overdue ?? 0), 0);
    return {
      outstanding,
      overdue,
      atRisk,
      par30: outstanding > 0 ? (atRisk / outstanding) * 100 : 0,
      inArrears: active.filter((b) => Number(b.amount_overdue ?? 0) > 0).length,
    };
  }, [active]);

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
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>
    </>
  );
}
