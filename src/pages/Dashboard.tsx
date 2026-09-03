/**
 * Command center — the microfinance operations overview.
 *
 * Every figure on this page is server-derived: portfolio and arrears come from
 * `mf_loan_balances` / `mf_loan_arrears` / `mf_par_summary`, and today's cash
 * movements come from the append-only `mf_repayments` / `mf_loan_disbursements`
 * event tables. React only labels, filters by permission and lays out — it
 * never computes outstanding principal, arrears, PAR or allocations.
 *
 * ERP dashboards (sales summary, receivables, backorders, low stock, payroll,
 * AI upsell widgets) were removed with the ERP domains; do not reintroduce
 * them here.
 */
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  HandCoins,
  Landmark,
  Loader2,
  Target,
  Users,
  Wallet,
} from "lucide-react";

import { DashboardAppLayout as DashboardLayout } from "@/apps/dashboard";
import { PageHeader, PageBody, Section } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useMfPortfolioReport, useMfCollectionsReport, useMfDisbursementsReport } from "@/hooks/useMfReports";
import { useMfArrears, useMfParSummary } from "@/hooks/useMfCollections";
import { useMfApplications } from "@/hooks/useMfApplications";
import { useMfClients } from "@/hooks/useMfClients";

interface Kpi {
  key: string;
  title: string;
  value: string;
  hint?: string;
  icon: React.ElementType;
  href?: string;
  tone?: "default" | "danger";
}

function KpiCard({ kpi, isLoading }: { kpi: Kpi; isLoading: boolean }) {
  const body = (
    <Card className="transition-all hover:border-primary/20 hover:shadow-md">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-1">
        <CardTitle className="text-xs font-medium text-muted-foreground">{kpi.title}</CardTitle>
        <kpi.icon
          className={
            kpi.tone === "danger" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-muted-foreground"
          }
        />
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {isLoading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <div
            className={
              kpi.tone === "danger"
                ? "text-xl font-bold tabular-nums text-destructive"
                : "text-xl font-bold tabular-nums"
            }
          >
            {kpi.value}
          </div>
        )}
        {kpi.hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{kpi.hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );

  return kpi.href ? <Link to={kpi.href}>{body}</Link> : body;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const canViewLoans = can("viewLoans");
  const canViewCollections = can("viewCollections");
  const canViewClients = can("viewClients");
  const canViewApplications = can("viewApplications");
  const canRecordRepayments = can("recordRepayments");

  const today = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);

  const { rows: portfolio, isLoading: portfolioLoading } = useMfPortfolioReport("active");
  const { arrears, isLoading: arrearsLoading } = useMfArrears();
  const { par, isLoading: parLoading } = useMfParSummary();
  const { rows: todaysCollections, isLoading: collectionsLoading } = useMfCollectionsReport(today, today);
  const { rows: todaysDisbursements, isLoading: disbursementsLoading } = useMfDisbursementsReport(today, today);
  const { applications, isLoading: applicationsLoading } = useMfApplications({ status: "open" });
  const { clients, isLoading: clientsLoading } = useMfClients({ status: "active" });

  const money = (amount: number) => formatCurrency(amount, baseCurrency);

  const portfolioOutstanding = portfolio.reduce((sum, r) => sum + r.total_outstanding, 0);
  const arrearsAmount = arrears.reduce((sum, r) => sum + r.arrears_amount, 0);
  const arrearsLoanCount = new Set(arrears.map((r) => r.loan_id)).size;
  const par30 = par.reduce((sum, r) => sum + (r.par_30 ?? 0), 0);
  const collectedToday = todaysCollections
    .filter((r) => r.status !== "reversed")
    .reduce((sum, r) => sum + r.amount, 0);
  const disbursedToday = todaysDisbursements
    .filter((r) => !r.reversed)
    .reduce((sum, r) => sum + r.amount, 0);

  const kpis: Kpi[] = [];
  if (canViewLoans) {
    kpis.push({
      key: "portfolio",
      title: "Portfolio outstanding",
      value: money(portfolioOutstanding),
      hint: `${portfolio.length} active loan${portfolio.length === 1 ? "" : "s"}`,
      icon: HandCoins,
      href: "/lending/reports/portfolio",
    });
  }
  if (canViewCollections) {
    kpis.push(
      {
        key: "arrears",
        title: "Arrears",
        value: money(arrearsAmount),
        hint: `${arrearsLoanCount} loan${arrearsLoanCount === 1 ? "" : "s"} in arrears`,
        icon: AlertTriangle,
        href: "/lending/reports/arrears",
        tone: arrearsAmount > 0 ? "danger" : "default",
      },
      {
        key: "par30",
        title: "PAR 30",
        value:
          portfolioOutstanding > 0
            ? `${((par30 / portfolioOutstanding) * 100).toFixed(1)}%`
            : "0.0%",
        hint: `${money(par30)} at risk over 30 days`,
        icon: Target,
        href: "/lending/reports/arrears",
      },
    );
  }
  if (canRecordRepayments || canViewCollections) {
    kpis.push({
      key: "collected",
      title: "Collected today",
      value: money(collectedToday),
      hint: `${todaysCollections.length} receipt${todaysCollections.length === 1 ? "" : "s"}`,
      icon: Wallet,
      href: "/lending/repayments",
    });
  }
  if (canViewLoans) {
    kpis.push({
      key: "disbursed",
      title: "Disbursed today",
      value: money(disbursedToday),
      hint: `${todaysDisbursements.length} disbursement${todaysDisbursements.length === 1 ? "" : "s"}`,
      icon: Landmark,
      href: "/lending/reports/disbursements",
    });
  }
  if (canViewApplications) {
    kpis.push({
      key: "applications",
      title: "Open applications",
      value: String(applications.length),
      hint: "Awaiting assessment or decision",
      icon: ClipboardList,
      href: "/lending/applications",
    });
  }
  if (canViewClients) {
    kpis.push({
      key: "clients",
      title: "Active clients",
      value: String(clients.length),
      icon: Users,
      href: "/lending",
    });
  }

  const kpiLoading =
    !currencyReady ||
    portfolioLoading ||
    arrearsLoading ||
    parLoading ||
    collectionsLoading ||
    disbursementsLoading ||
    applicationsLoading ||
    clientsLoading;

  const worstArrears = useMemo(
    () =>
      [...arrears]
        .sort((a, b) => b.days_past_due - a.days_past_due || b.arrears_amount - a.arrears_amount)
        .slice(0, 8),
    [arrears],
  );

  if (!currencyReady) {
    return (
      <DashboardLayout>
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <PageHeader
        title="Command center"
        description="Today's lending operations — portfolio, arrears, collections and disbursements."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRecordRepayments ? (
              <Button size="sm" onClick={() => navigate("/lending/repayments")}>
                <Wallet className="h-4 w-4" />
                Record repayment
              </Button>
            ) : null}
            {canViewApplications ? (
              <Button size="sm" variant="outline" onClick={() => navigate("/lending/applications")}>
                <ClipboardList className="h-4 w-4" />
                Applications
              </Button>
            ) : null}
            {canViewCollections ? (
              <Button size="sm" variant="outline" onClick={() => navigate("/lending/collections")}>
                <Target className="h-4 w-4" />
                Collections
              </Button>
            ) : null}
          </div>
        }
      />
      <PageBody>
        {kpis.length > 0 ? (
          <Section title="Portfolio at a glance" unstyled>
            <div className="grid grid-cols-1 gap-3 @[26rem]/page:grid-cols-2 @[52rem]/page:grid-cols-3 @[72rem]/page:grid-cols-6">
              {kpis.map((kpi) => (
                <KpiCard key={kpi.key} kpi={kpi} isLoading={kpiLoading} />
              ))}
            </div>
          </Section>
        ) : null}

        {canViewCollections ? (
          <Section
            title="Worst arrears"
            description="Highest days past due first — follow up from the collections workspace."
          >
            {arrearsLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : worstArrears.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No loan is in arrears today.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Loan</TableHead>
                    <TableHead>Installment</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Arrears</TableHead>
                    <TableHead className="text-right">DPD</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {worstArrears.map((row) => (
                    <TableRow key={`${row.loan_id}-${row.installment_no}`}>
                      <TableCell className="font-medium">{row.loan_number}</TableCell>
                      <TableCell>#{row.installment_no}</TableCell>
                      <TableCell>{format(new Date(row.due_date), "dd MMM yyyy")}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">
                        {money(row.arrears_amount)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant="destructive">{row.days_past_due}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-3">
              <Button asChild size="sm" variant="ghost">
                <Link to="/lending/reports/arrears">
                  Full arrears &amp; PAR report
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </Section>
        ) : null}

        {canRecordRepayments || canViewCollections ? (
          <Section title="Today's receipts" description="Cash, bank and mobile-money repayments recorded today.">
            {collectionsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : todaysCollections.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No repayment has been recorded today.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Loan</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {todaysCollections.slice(0, 8).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.receipt_number ?? "—"}</TableCell>
                      <TableCell>{row.client_name}</TableCell>
                      <TableCell>{row.loan_number}</TableCell>
                      <TableCell className="capitalize">{row.method.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.status === "reversed" ? (
                          <span className="text-muted-foreground line-through">{money(row.amount)}</span>
                        ) : (
                          money(row.amount)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-3">
              <Button asChild size="sm" variant="ghost">
                <Link to="/lending/repayments">
                  Repayments workspace
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </Section>
        ) : null}
      </PageBody>
    </DashboardLayout>
  );
}
