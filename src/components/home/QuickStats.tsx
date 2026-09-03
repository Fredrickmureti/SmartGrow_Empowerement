/**
 * Launcher stats — microfinance headline figures.
 *
 * Server-derived only: portfolio from `mf_loan_balances`, arrears from
 * `mf_loan_arrears`, today's receipts from the append-only `mf_repayments`
 * events. No ERP revenue/expense/inventory metrics.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, HandCoins, Users, Wallet } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useMfPortfolioReport, useMfCollectionsReport } from "@/hooks/useMfReports";
import { useMfArrears } from "@/hooks/useMfCollections";
import { useMfClients } from "@/hooks/useMfClients";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  href?: string;
  color?: string;
  tone?: "default" | "danger";
  isLoading?: boolean;
}

function StatCard({
  title,
  value,
  icon: Icon,
  href,
  color = "hsl(var(--primary))",
  tone = "default",
  isLoading = false,
}: StatCardProps) {
  const content = (
    <Card
      className={cn(
        "relative overflow-hidden transition-all",
        href && "cursor-pointer hover:border-primary/20 hover:shadow-md",
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between p-3 pb-1 sm:p-6 sm:pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground sm:text-sm">
          {title}
        </CardTitle>
        <div
          className="flex h-6 w-6 items-center justify-center rounded-lg sm:h-8 sm:w-8"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon className="h-3 w-3 sm:h-4 sm:w-4" style={{ color }} />
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
        {isLoading ? (
          <Skeleton className="h-6 w-20 sm:h-8 sm:w-24" />
        ) : (
          <div
            className={cn(
              "text-lg font-bold tabular-nums sm:text-2xl",
              tone === "danger" && "text-destructive",
            )}
          >
            {value}
          </div>
        )}
      </CardContent>
      {href && (
        <div className="absolute bottom-2 right-2">
          <ArrowRight className="h-4 w-4 text-muted-foreground/50" />
        </div>
      )}
    </Card>
  );

  return href ? <Link to={href}>{content}</Link> : content;
}

interface QuickStatsProps {
  className?: string;
  isLoading?: boolean;
}

export function QuickStats({ className, isLoading = false }: QuickStatsProps) {
  const { can } = usePermissions();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const today = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);
  const { rows: portfolio, isLoading: portfolioLoading } = useMfPortfolioReport("active");
  const { arrears, isLoading: arrearsLoading } = useMfArrears();
  const { rows: receipts, isLoading: receiptsLoading } = useMfCollectionsReport(today, today);
  const { clients, isLoading: clientsLoading } = useMfClients({ status: "active" });

  const busy =
    isLoading ||
    !currencyReady ||
    portfolioLoading ||
    arrearsLoading ||
    receiptsLoading ||
    clientsLoading;

  const statCards = useMemo(() => {
    const money = (amount: number) => formatCurrency(amount, baseCurrency);
    const result: StatCardProps[] = [];

    if (can("viewLoans")) {
      result.push({
        title: "Portfolio outstanding",
        value: money(portfolio.reduce((sum, r) => sum + r.total_outstanding, 0)),
        icon: HandCoins,
        href: "/lending/reports/portfolio",
        color: "hsl(142, 76%, 36%)",
      });
    }

    if (can("viewCollections")) {
      const arrearsAmount = arrears.reduce((sum, r) => sum + r.arrears_amount, 0);
      result.push({
        title: "Arrears",
        value: money(arrearsAmount),
        icon: AlertTriangle,
        href: "/lending/reports/arrears",
        color: "hsl(25, 95%, 53%)",
        tone: arrearsAmount > 0 ? "danger" : "default",
      });
    }

    if (can("recordRepayments") || can("viewCollections")) {
      result.push({
        title: "Collected today",
        value: money(
          receipts.filter((r) => r.status !== "reversed").reduce((sum, r) => sum + r.amount, 0),
        ),
        icon: Wallet,
        href: "/lending/repayments",
        color: "hsl(173, 80%, 40%)",
      });
    }

    if (can("viewClients")) {
      result.push({
        title: "Active clients",
        value: clients.length,
        icon: Users,
        href: "/lending",
        color: "hsl(262, 83%, 58%)",
      });
    }

    return result.slice(0, 4);
  }, [can, formatCurrency, baseCurrency, portfolio, arrears, receipts, clients]);

  if (statCards.length === 0) return null;

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 @[26rem]/page:grid-cols-2 @[52rem]/page:grid-cols-4",
        className,
      )}
    >
      {statCards.map((stat) => (
        <StatCard key={stat.title} {...stat} isLoading={busy} />
      ))}
    </div>
  );
}
