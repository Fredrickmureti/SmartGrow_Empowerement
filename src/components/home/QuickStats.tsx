/**
 * QuickStats Component
 * 
 * Shows key metrics on the home page based on installed apps.
 * Adapts to show relevant stats for the user's workspace.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Users, 
  FileText, 
  Package,
  Receipt,
  Briefcase,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useCurrency } from "@/hooks/useCurrency";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useQuickStatsCounts } from "@/hooks/useQuickStatsCounts";

interface StatCardProps {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  icon: React.ElementType;
  href?: string;
  color?: string;
  isLoading?: boolean;
}

function StatCard({
  title,
  value,
  change,
  changeLabel = "vs last month",
  icon: Icon,
  href,
  color = "hsl(var(--primary))",
  isLoading = false,
}: StatCardProps) {
  const content = (
    <Card className={cn(
      "relative overflow-hidden transition-all",
      href && "hover:shadow-md hover:border-primary/20 cursor-pointer"
    )}>
      <CardHeader className="flex flex-row items-center justify-between p-3 sm:p-6 pb-1 sm:pb-2">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div
          className="h-6 w-6 sm:h-8 sm:w-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon className="h-3 w-3 sm:h-4 sm:w-4" style={{ color }} />
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
        {isLoading ? (
          <Skeleton className="h-6 sm:h-8 w-20 sm:w-24" />
        ) : (
          <>
            <div className="text-lg sm:text-2xl font-bold">{value}</div>
            {change !== undefined && (
              <p className={cn(
                "text-xs flex items-center gap-1 mt-1",
                change >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
              )}>
                {change >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {change >= 0 ? "+" : ""}{change}% {changeLabel}
              </p>
            )}
          </>
        )}
      </CardContent>
      {href && (
        <div className="absolute bottom-2 right-2">
          <ArrowRight className="h-4 w-4 text-muted-foreground/50" />
        </div>
      )}
    </Card>
  );

  if (href) {
    return <Link to={href}>{content}</Link>;
  }

  return content;
}

interface QuickStatsProps {
  className?: string;
  isLoading?: boolean;
}

export function QuickStats({ className, isLoading = false }: QuickStatsProps) {
  const { isInstalled } = useInstalledApps();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { stats, isLoading: statsLoading } = useDashboardStats();
  const { leadCount, employeeCount, isLoading: countsLoading } = useQuickStatsCounts();

  // Determine which stats to show based on installed apps
  const statCards = useMemo(() => {
    const result: StatCardProps[] = [];

    // Finance stats (always shown if finance app installed)
    if (isInstalled("finance")) {
      result.push({
        title: "Total Revenue",
        value: formatCurrency(stats.totalRevenue, baseCurrency),
        change: stats.totalRevenueChange ? Math.round(stats.totalRevenueChange * 10) / 10 : undefined,
        icon: DollarSign,
        href: "/finance/reports",
        color: "hsl(142, 76%, 36%)",
      });
    }

    // Sales stats
    if (isInstalled("sales")) {
      result.push({
        title: "Outstanding",
        value: formatCurrency(stats.outstandingInvoices, baseCurrency),
        icon: FileText,
        href: "/sales/invoices",
        color: "hsl(217, 91%, 60%)",
      });
    }

    // Purchases stats
    if (isInstalled("purchases")) {
      result.push({
        title: "Total Expenses",
        value: formatCurrency(stats.totalExpenses, baseCurrency),
        change: stats.totalExpensesChange ? Math.round(stats.totalExpensesChange * 10) / 10 : undefined,
        icon: Receipt,
        href: "/purchases/bills",
        color: "hsl(25, 95%, 53%)",
      });
    }

    // Inventory stats
    if (isInstalled("inventory")) {
      result.push({
        title: "Net Profit",
        value: formatCurrency(stats.netProfit, baseCurrency),
        icon: Package,
        href: "/inventory-app/products",
        color: "hsl(262, 83%, 58%)",
      });
    }

    // CRM stats — real data
    if (isInstalled("crm")) {
      result.push({
        title: "Active Leads",
        value: leadCount,
        icon: Briefcase,
        href: "/crm-app/pipeline",
        color: "hsl(173, 80%, 40%)",
      });
    }

    // HR stats — uses the Employees foundation app (Odoo `hr`).
    // The legacy "hr" alias is accepted for back-compat with older
    // entitlement rows; new tenants are seeded with "employees".
    if (isInstalled("employees") || isInstalled("hr")) {
      result.push({
        title: "Employees",
        value: employeeCount,
        icon: Users,
        href: "/hr/employees",
        color: "hsl(45, 93%, 47%)",
      });
    }

    // Limit to 4 stats for the grid
    return result.slice(0, 4);
  }, [isInstalled, formatCurrency, baseCurrency, stats, leadCount, employeeCount]);

  if (statCards.length === 0) {
    return null;
  }

  return (
    <div className={cn("grid gap-2 sm:gap-4 grid-cols-1 @[26rem]/page:grid-cols-2 @[52rem]/page:grid-cols-4", className)}>
      {statCards.map((stat, index) => (
        <StatCard key={index} {...stat} isLoading={isLoading || !currencyReady || statsLoading || countsLoading} />
      ))}
    </div>
  );
}
