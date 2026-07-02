import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from "recharts";
import { useCurrency } from "@/hooks/useCurrency";
import { PayrollRun, Payslip } from "@/hooks/usePayroll";
import { Employee } from "@/hooks/useEmployees";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Users,
  Receipt,
  Percent,
} from "lucide-react";
import { format, parseISO } from "date-fns";

interface Props {
  payrollRuns: PayrollRun[];
  employees: Employee[];
  payslips: Payslip[];
}

const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-2, 173 58% 39%))",
  "hsl(var(--chart-3, 197 37% 24%))",
  "hsl(var(--chart-4, 43 74% 66%))",
  "hsl(var(--chart-5, 27 87% 67%))",
];

export function PayrollAnalyticsDashboard({ payrollRuns, employees, payslips }: Props) {
  const { formatCurrency } = useCurrency();

  // Monthly cost trend data
  const monthlyCostTrend = useMemo(() => {
    const approved = payrollRuns
      .filter((r) => r.status === "approved" || r.status === "paid")
      .sort((a, b) => a.pay_period_start.localeCompare(b.pay_period_start));

    return approved.slice(-12).map((run) => {
      const totalDeductions = run.total_gross - run.total_net;
      return {
        month: format(parseISO(run.pay_period_start), "MMM yy"),
        gross: run.total_gross,
        net: run.total_net,
        deductions: totalDeductions,
        employees: run.employee_count,
      };
    });
  }, [payrollRuns]);

  // Department-wise salary breakdown
  const departmentBreakdown = useMemo(() => {
    const deptMap = new Map<string, { gross: number; count: number }>();
    for (const emp of employees.filter((e) => e.is_active)) {
      const dept = emp.department_name || emp.department || "Unassigned";
      const gross =
        (emp.basic_salary || 0) +
        (emp.housing_allowance || 0) +
        (emp.transport_allowance || 0) +
        Object.values(emp.other_allowances || {}).reduce((s, v) => s + (v || 0), 0);
      const existing = deptMap.get(dept) || { gross: 0, count: 0 };
      deptMap.set(dept, { gross: existing.gross + gross, count: existing.count + 1 });
    }
    return Array.from(deptMap.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.gross - a.gross);
  }, [employees]);

  // Deductions summary from latest payroll
  const latestRun = payrollRuns
    .filter((r) => r.status === "approved" || r.status === "paid")
    .sort((a, b) => b.pay_period_start.localeCompare(a.pay_period_start))[0];

  // Summary KPIs
  const totalMonthlyGross = employees
    .filter((e) => e.is_active)
    .reduce(
      (sum, emp) =>
        sum +
        (emp.basic_salary || 0) +
        (emp.housing_allowance || 0) +
        (emp.transport_allowance || 0) +
        Object.values(emp.other_allowances || {}).reduce((s, v) => s + (v || 0), 0),
      0
    );

  const activeCount = employees.filter((e) => e.is_active).length;
  const avgSalary = activeCount > 0 ? totalMonthlyGross / activeCount : 0;

  const prevRun = payrollRuns
    .filter((r) => r.status === "approved" || r.status === "paid")
    .sort((a, b) => b.pay_period_start.localeCompare(a.pay_period_start))[1];
  const costChange =
    latestRun && prevRun
      ? ((latestRun.total_gross - prevRun.total_gross) / prevRun.total_gross) * 100
      : 0;

  const deductionRate =
    latestRun && latestRun.total_gross > 0
      ? ((latestRun.total_gross - latestRun.total_net) / latestRun.total_gross) * 100
      : 0;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Payroll Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(latestRun?.total_gross || totalMonthlyGross)}</div>
            {costChange !== 0 && (
              <p className={`text-xs flex items-center gap-1 ${costChange > 0 ? "text-destructive" : "text-green-600"}`}>
                {costChange > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {Math.abs(costChange).toFixed(1)}% from previous period
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Employees</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
            <p className="text-xs text-muted-foreground">On current payroll</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Average Salary</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(avgSalary)}</div>
            <p className="text-xs text-muted-foreground">Per employee (gross)</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Deduction Rate</CardTitle>
            <Percent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{deductionRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">Of gross pay (latest run)</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Monthly Cost Trend */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payroll Cost Trend</CardTitle>
            <CardDescription>Monthly gross vs net pay over time</CardDescription>
          </CardHeader>
          <CardContent>
            {monthlyCostTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={monthlyCostTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="month" className="text-xs" />
                  <YAxis className="text-xs" tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="gross"
                    name="Gross Pay"
                    stroke={CHART_COLORS[0]}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="Net Pay"
                    stroke={CHART_COLORS[1]}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="deductions"
                    name="Deductions"
                    stroke={CHART_COLORS[4]}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                No payroll data yet. Process your first payroll run to see trends.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Department Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Salary by Department</CardTitle>
            <CardDescription>Monthly gross salary distribution</CardDescription>
          </CardHeader>
          <CardContent>
            {departmentBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={departmentBreakdown} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" className="text-xs" tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                  <YAxis dataKey="name" type="category" className="text-xs" width={100} />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  <Bar dataKey="gross" name="Gross Salary" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                No department data available.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Headcount by Department */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Headcount by Department</CardTitle>
            <CardDescription>Active employee distribution</CardDescription>
          </CardHeader>
          <CardContent>
            {departmentBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={departmentBreakdown}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, count }) => `${name}: ${count}`}
                    outerRadius={100}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {departmentBreakdown.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                No employee data available.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Payroll Runs History */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Employee Count Trend</CardTitle>
            <CardDescription>Employees processed per payroll run</CardDescription>
          </CardHeader>
          <CardContent>
            {monthlyCostTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyCostTrend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="month" className="text-xs" />
                  <YAxis className="text-xs" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  <Bar dataKey="employees" name="Employees" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
                No payroll history available.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
