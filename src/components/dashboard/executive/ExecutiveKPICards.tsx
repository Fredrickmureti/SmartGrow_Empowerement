import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { DollarSign, Receipt, Coins, Wallet, Landmark, Users, ArrowUpRight, ArrowDownRight } from "lucide-react";

interface ExecutiveKPICardsProps {
  totalRevenue: number;
  totalRevenueChange: number;
  totalExpenses: number;
  totalExpensesChange: number;
  netProfit: number;
  totalReceivables: number;
  totalPayables: number;
  cashPosition: number;
  totalCustomers: number;
  displayAmount: (amount: number) => string;
}

export function ExecutiveKPICards({
  totalRevenue,
  totalRevenueChange,
  totalExpenses,
  totalExpensesChange,
  netProfit,
  totalReceivables,
  totalPayables,
  cashPosition,
  totalCustomers,
  displayAmount,
}: ExecutiveKPICardsProps) {
  const margin = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(1) : "0.0";

  const kpis = [
    {
      label: "Org Revenue",
      value: displayAmount(totalRevenue),
      icon: DollarSign,
      iconColor: "text-success",
      valueColor: "text-success",
      sub: (
        <ChangeIndicator value={totalRevenueChange} positiveIsGood />
      ),
    },
    {
      label: "Org Expenses",
      value: displayAmount(totalExpenses),
      icon: Receipt,
      iconColor: "text-destructive",
      valueColor: "text-destructive",
      sub: (
        <ChangeIndicator value={totalExpensesChange} positiveIsGood={false} />
      ),
    },
    {
      label: "Net Profit",
      value: displayAmount(netProfit),
      icon: Coins,
      iconColor: netProfit >= 0 ? "text-success" : "text-destructive",
      valueColor: netProfit >= 0 ? "text-success" : "text-destructive",
      sub: <span className="text-xs text-muted-foreground">Margin: {margin}%</span>,
    },
    {
      label: "Outstanding AR",
      value: displayAmount(totalReceivables),
      icon: Wallet,
      iconColor: "text-warning",
      valueColor: "text-warning",
      sub: <span className="text-xs text-muted-foreground">AP: {displayAmount(totalPayables)}</span>,
    },
    {
      label: "Cash Position",
      value: displayAmount(cashPosition),
      icon: Landmark,
      iconColor: cashPosition >= 0 ? "text-primary" : "text-destructive",
      valueColor: cashPosition >= 0 ? "text-primary" : "text-destructive",
      sub: <span className="text-xs text-muted-foreground">All bank accounts</span>,
    },
    {
      label: "Total Customers",
      value: totalCustomers.toLocaleString(),
      icon: Users,
      iconColor: "text-primary",
      valueColor: "text-foreground",
      sub: <span className="text-xs text-muted-foreground">Current company</span>,
    },
  ];

  return (
    <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {kpis.map((kpi) => {
        const Icon = kpi.icon;
        return (
          <Card key={kpi.label} className="min-w-0 overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription className="text-xs truncate">{kpi.label}</CardDescription>
              <Icon className={`h-4 w-4 shrink-0 ${kpi.iconColor}`} />
            </CardHeader>
            <CardContent className="overflow-hidden">
              <div className={`text-base sm:text-lg xl:text-base 2xl:text-xl font-bold truncate ${kpi.valueColor}`}>{kpi.value}</div>
              <div className="mt-1 truncate">{kpi.sub}</div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function ChangeIndicator({ value, positiveIsGood }: { value: number; positiveIsGood: boolean }) {
  const isPositive = value >= 0;
  const isGood = positiveIsGood ? isPositive : !isPositive;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      {isPositive ? (
        <ArrowUpRight className={`h-3 w-3 ${isGood ? "text-success" : "text-destructive"}`} />
      ) : (
        <ArrowDownRight className={`h-3 w-3 ${isGood ? "text-success" : "text-destructive"}`} />
      )}
      <span className={isGood ? "text-success" : "text-destructive"}>
        {Math.abs(value).toFixed(1)}%
      </span>
      <span>vs last month</span>
    </div>
  );
}
