/**
 * GarnishmentDashboard — operational overview for the Garnishments subsystem.
 *
 * Reads the `garnishment_dashboard_summary(org, business)` RPC and renders:
 *  - totals (active/suspended orders, owed vs accrued vs paid)
 *  - mix by kind
 *  - carry-forward queue (deduction shortfalls awaiting next run)
 *  - overdue remittances (cash not yet sent to the payee)
 *  - expiring orders (next 30 days)
 *  - recent lifecycle events
 *
 * Drop-in: <GarnishmentDashboard /> above the order table.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Clock, History, Banknote, Scale, Layers } from "lucide-react";
import { useMemo } from "react";

interface DashboardSummary {
  totals: {
    active_orders?: number;
    suspended_orders?: number;
    total_owed?: number;
    total_accrued?: number;
    total_paid?: number;
  };
  by_kind: Array<{ kind: string; orders: number; accrued: number }>;
  carry_forward: Array<{
    id: string; garnishment_id: string; employee_id: string;
    reason_code: string; shortfall: number; source_period_end: string;
  }>;
  overdue_remittances: Array<{
    id: string; garnishment_id: string; amount: number;
    due_date: string; days_overdue: number;
  }>;
  expiring_orders: Array<{
    id: string; employee_id: string; end_date: string;
    days_until_expiry: number; kind: string;
  }>;
  recent_events: Array<{
    id: string; garnishment_id: string; event: string;
    from_status: string | null; to_status: string;
    reason_text: string | null; effective_at: string;
  }>;
  evaluated_at: string;
}

const fmt = (n?: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n ?? 0);

const REASON_LABEL: Record<string, string> = {
  floor_breached: "Take-home floor",
  aggregate_cap_exhausted: "Aggregate cap",
  disposable_exhausted: "Disposable exhausted",
};

export function GarnishmentDashboard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { employees } = useEmployees();

  const empById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, `${e.first_name} ${e.last_name}`);
    return m;
  }, [employees]);

  const { data, isLoading } = useQuery({
    queryKey: ["garnishment-dashboard", currentOrg?.id, currentBusiness?.id ?? null],
    enabled: !!currentOrg?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<DashboardSummary> => {
      const { data, error } = await (supabase as any).rpc("garnishment_dashboard_summary", {
        p_org_id: currentOrg!.id,
        p_business_id: currentBusiness?.id ?? null,
      });
      if (error) throw error;
      return data as DashboardSummary;
    },
  });

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">Loading dashboard…</CardContent>
      </Card>
    );
  }

  const t = data.totals ?? {};
  const outstanding = (t.total_accrued ?? 0) - (t.total_paid ?? 0);

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <KPI icon={<Scale className="h-4 w-4" />} label="Active orders" value={String(t.active_orders ?? 0)}
             hint={`${t.suspended_orders ?? 0} suspended`} />
        <KPI icon={<Layers className="h-4 w-4" />} label="Total owed" value={fmt(t.total_owed)} />
        <KPI icon={<Banknote className="h-4 w-4" />} label="Accrued (payroll)" value={fmt(t.total_accrued)}
             hint={`${fmt(t.total_paid)} paid`} />
        <KPI icon={<AlertTriangle className="h-4 w-4" />} label="Outstanding to payee" value={fmt(outstanding)}
             tone={outstanding > 0 ? "warn" : "ok"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Carry-forward */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" /> Carry-forward queue
            </CardTitle>
            <CardDescription>
              Deduction shortfalls from prior runs to be added on the next payroll.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.carry_forward.length === 0 ? (
              <p className="text-xs text-muted-foreground">No pending carry-forward.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Shortfall</TableHead>
                    <TableHead>From period</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.carry_forward.slice(0, 8).map((cf) => (
                    <TableRow key={cf.id}>
                      <TableCell className="text-xs">{empById.get(cf.employee_id) ?? cf.employee_id.slice(0, 8)}</TableCell>
                      <TableCell><Badge variant="outline">{REASON_LABEL[cf.reason_code] ?? cf.reason_code}</Badge></TableCell>
                      <TableCell className="text-right text-xs">{fmt(cf.shortfall)}</TableCell>
                      <TableCell className="text-xs">{cf.source_period_end}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Overdue remittances */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" /> Overdue remittances
            </CardTitle>
            <CardDescription>Liabilities past their due date — pay the payee.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.overdue_remittances.length === 0 ? (
              <p className="text-xs text-muted-foreground">All remittances are current.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Due</TableHead>
                    <TableHead>Days late</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.overdue_remittances.slice(0, 8).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{r.due_date}</TableCell>
                      <TableCell><Badge variant="destructive">{r.days_overdue}d</Badge></TableCell>
                      <TableCell className="text-right text-xs">{fmt(r.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Expiring */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-warning" /> Expiring soon
            </CardTitle>
            <CardDescription>Orders ending in the next 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.expiring_orders.length === 0 ? (
              <p className="text-xs text-muted-foreground">No orders expiring soon.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead>In</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.expiring_orders.slice(0, 8).map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="text-xs">{empById.get(o.employee_id) ?? o.employee_id.slice(0, 8)}</TableCell>
                      <TableCell className="text-xs">{o.kind.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-xs">{o.end_date}</TableCell>
                      <TableCell><Badge variant={o.days_until_expiry <= 7 ? "destructive" : "outline"}>{o.days_until_expiry}d</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent events */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" /> Recent lifecycle events
            </CardTitle>
            <CardDescription>Latest status transitions across all orders.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recent_events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No events yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>From → To</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recent_events.slice(0, 8).map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs">{new Date(e.effective_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline">{e.event}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {(e.from_status ?? "—")} → {e.to_status}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* By kind */}
      {data.by_kind.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Mix by kind</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.by_kind.map((k) => (
              <Badge key={k.kind} variant="secondary" className="text-xs">
                {k.kind.replace(/_/g, " ")} · {k.orders} order(s) · {fmt(k.accrued)} accrued
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KPI({
  icon, label, value, hint, tone,
}: { icon: React.ReactNode; label: string; value: string; hint?: string; tone?: "warn" | "ok" }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}<span>{label}</span>
        </div>
        <div className={`mt-1 text-xl font-semibold ${tone === "warn" ? "text-destructive" : ""}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
