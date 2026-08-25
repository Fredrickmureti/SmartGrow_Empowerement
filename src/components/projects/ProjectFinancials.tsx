/**
 * ProjectFinancials
 *
 * Replaces the legacy decorative ProjectProfitability widget.
 * All figures come from the analytic ledger via compute_project_profitability.
 * Cost and revenue rows below the KPIs are real source rows.
 */
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, TrendingUp, TrendingDown, Clock, Wallet, ReceiptText, FileText, Building2, Users } from "lucide-react";
import { format } from "date-fns";
import { useProjectFinancials } from "@/hooks/projects/useProjectFinancials";
import { Project } from "@/hooks/projects/useProjects";

interface Props { project: Project }

const sourceIcon = (t: string) => {
  switch (t) {
    case "timesheet":     return <Clock className="h-3.5 w-3.5" />;
    case "expense":       return <Wallet className="h-3.5 w-3.5" />;
    case "vendor_bill":   return <ReceiptText className="h-3.5 w-3.5" />;
    case "invoice":       return <FileText className="h-3.5 w-3.5" />;
    case "milestone":     return <Building2 className="h-3.5 w-3.5" />;
    default:              return <Users className="h-3.5 w-3.5" />;
  }
};

// A record with no currency renders as an absence — never as a figure wearing
// a currency it was not denominated in (ADR 0136).
const fmt = (n: number | null | undefined, cur?: string | null) =>
  cur ? formatCurrency(Number(n ?? 0), cur) : "—";

export function ProjectFinancials({ project }: Props) {
  const { data, costs, revenues, isLoading, error } = useProjectFinancials(project.id);

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }
  if (error) {
    return <Card><CardContent className="p-4 text-sm text-destructive">Failed to load profitability: {error}</CardContent></Card>;
  }
  if (!data) return null;

  const cur = data.currency ?? null;
  const profitable = data.margin >= 0;

  return (
    <div className="space-y-4">
      {/* KPI grid */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Revenue</p>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold mt-1">{fmt(data.revenue_total, cur)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Cost</p>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold mt-1">{fmt(data.cost_total, cur)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Margin</p>
              {profitable ? <TrendingUp className="h-4 w-4 text-green-500" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
            </div>
            <p className={`text-xl font-semibold mt-1 ${profitable ? "text-green-600" : "text-destructive"}`}>
              {fmt(data.margin, cur)}
            </p>
            {data.margin_pct !== null && (
              <p className="text-[11px] text-muted-foreground">{data.margin_pct}%</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Hours (logged / planned)</p>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold mt-1">
              {Number(data.logged_hours).toFixed(1)} / {Number(data.planned_hours).toFixed(1)}h
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Budget consumption */}
      {data.budget !== null && data.budget !== undefined && Number(data.budget) > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>Budget consumption</span>
              <span className="font-medium">
                {fmt(data.cost_total, cur)} / {fmt(Number(data.budget), cur)}
                {data.budget_used_pct !== null && <span className="text-muted-foreground"> · {data.budget_used_pct}%</span>}
              </span>
            </div>
            <Progress value={Math.min(100, Number(data.budget_used_pct ?? 0))} className="h-2" />
          </CardContent>
        </Card>
      )}

      {/* Breakdowns */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">Cost breakdown</CardTitle></CardHeader>
          <CardContent className="p-4 pt-0 space-y-1">
            {Object.keys(data.cost_by_source).length === 0 && (
              <p className="text-xs text-muted-foreground">No cost recorded.</p>
            )}
            {Object.entries(data.cost_by_source).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 capitalize">{sourceIcon(k)}{k.replace("_", " ")}</span>
                <span className="font-medium">{fmt(Number(v), cur)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardTitle className="text-sm">Revenue breakdown</CardTitle></CardHeader>
          <CardContent className="p-4 pt-0 space-y-1">
            {Object.keys(data.revenue_by_source).length === 0 && (
              <p className="text-xs text-muted-foreground">No revenue recorded.</p>
            )}
            {Object.entries(data.revenue_by_source).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 capitalize">{sourceIcon(k)}{k.replace("_", " ")}</span>
                <span className="font-medium">{fmt(Number(v), cur)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Source ledger drill-down */}
      <Tabs defaultValue="costs">
        <TabsList>
          <TabsTrigger value="costs">Cost ledger ({costs.length})</TabsTrigger>
          <TabsTrigger value="revenues">Revenue ledger ({revenues.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="costs" className="mt-3">
          <Card><CardContent className="p-0">
            {costs.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">No cost entries yet.</p>
            ) : (
              <div className="divide-y">
                {costs.map(e => (
                  <div key={e.id} className="flex items-center justify-between p-3 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      {sourceIcon(e.source_type)}
                      <div className="min-w-0">
                        <p className="truncate">{e.description || "—"}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {format(new Date(e.posted_at), "MMM d, yyyy")} · <Badge variant="outline" className="text-[10px] h-4 px-1 capitalize">{e.source_type.replace("_", " ")}</Badge>
                          {e.hours != null && <> · {Number(e.hours).toFixed(2)}h</>}
                        </p>
                      </div>
                    </div>
                    <span className="font-medium shrink-0">{fmt(e.amount, e.currency || cur)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="revenues" className="mt-3">
          <Card><CardContent className="p-0">
            {revenues.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">No revenue entries yet.</p>
            ) : (
              <div className="divide-y">
                {revenues.map(e => (
                  <div key={e.id} className="flex items-center justify-between p-3 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      {sourceIcon(e.source_type)}
                      <div className="min-w-0">
                        <p className="truncate">{e.description || "—"}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {format(new Date(e.posted_at), "MMM d, yyyy")} · <Badge variant="outline" className="text-[10px] h-4 px-1 capitalize">{e.source_type.replace("_", " ")}</Badge>
                        </p>
                      </div>
                    </div>
                    <span className="font-medium shrink-0">{fmt(e.amount, e.currency || cur)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ProjectFinancials;
