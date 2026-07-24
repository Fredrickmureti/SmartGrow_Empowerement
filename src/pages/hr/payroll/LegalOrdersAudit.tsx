/**
 * Legal Orders — Audit tab. Phase 8 step 1.
 *
 * Read-only unified timeline for a single legal order. Backed by the
 * `v_legal_order_audit_timeline` projection (security_invoker) which
 * unions lifecycle events, audit log entries, notification dispatches
 * and remittance batch milestones. Also renders the point-in-time
 * balance from the `legal_order_running_balance` RPC.
 *
 * Read-only by design — writing back into any of the source tables
 * from this surface would bypass the FSM guard rails, so this page
 * strictly displays projections.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useLegalOrders } from "@/hooks/useLegalOrders";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Activity, ArrowUpRight, Banknote, Bell, ClipboardList, ShieldAlert, ChevronDown, ChevronRight,
} from "lucide-react";

type TimelineRow = {
  organization_id: string;
  legal_order_id: string;
  occurred_at: string | null;
  entry_kind: "lifecycle_event" | "audit_log" | "notification" | "remittance_batch";
  action: string | null;
  actor_user_id: string | null;
  details: Record<string, any> | null;
  source_row_id: string | null;
  source_table: string | null;
};

type RunningBalance = {
  legal_order_id: string;
  as_of: string;
  total_owed: number | null;
  accrued: number | null;
  remitted: number | null;
  outstanding: number | null;
  last_accrual_at: string | null;
  last_remittance_at: string | null;
};

function fmt(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function KindIcon({ kind }: { kind: TimelineRow["entry_kind"] }) {
  const cls = "h-4 w-4";
  switch (kind) {
    case "lifecycle_event": return <Activity className={cls} />;
    case "remittance_batch": return <Banknote className={cls} />;
    case "notification": return <Bell className={cls} />;
    case "audit_log": return <ShieldAlert className={cls} />;
    default: return <ClipboardList className={cls} />;
  }
}

export default function LegalOrdersAudit() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const { data: orders = [] } = useLegalOrders();

  const [selectedOrderId, setSelectedOrderId] = useState<string | "">("");
  const [asOf, setAsOf] = useState<string>(new Date().toISOString().slice(0, 10));

  const activeOrderId = selectedOrderId || (orders[0]?.id ?? "");

  const timelineQ = useQuery<TimelineRow[]>({
    queryKey: ["legal-order-audit-timeline", orgId, activeOrderId],
    enabled: !!orgId && !!activeOrderId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_legal_order_audit_timeline")
        .select("*")
        .eq("organization_id", orgId)
        .eq("legal_order_id", activeOrderId)
        .order("occurred_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as TimelineRow[];
    },
  });

  const balanceQ = useQuery<RunningBalance | null>({
    queryKey: ["legal-order-running-balance", orgId, activeOrderId, asOf],
    enabled: !!orgId && !!activeOrderId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "legal_order_running_balance",
        { _organization_id: orgId, _legal_order_id: activeOrderId, _as_of: asOf },
      );
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as RunningBalance | null;
    },
  });

  const selectedOrder = useMemo(
    () => orders.find((o: any) => o.id === activeOrderId),
    [orders, activeOrderId],
  );

  return (
    <div className="p-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Legal order</label>
          <Select value={activeOrderId} onValueChange={setSelectedOrderId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Pick a legal order" />
            </SelectTrigger>
            <SelectContent>
              {orders.map((o: any) => (
                <SelectItem key={o.id} value={o.id}>
                  {(o.case_reference || o.kind_code || o.id) + " — " + (o.authority_name ?? o.employee_id ?? "")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Balance as of</label>
          <Input
            type="date"
            className="mt-1"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <BalanceKpi label="Total owed" value={fmt(balanceQ.data?.total_owed)} hint="From order header" />
        <BalanceKpi label="Accrued to date" value={fmt(balanceQ.data?.accrued)} />
        <BalanceKpi label="Remitted to date" value={fmt(balanceQ.data?.remitted)} />
        <BalanceKpi
          label="Outstanding"
          value={fmt(balanceQ.data?.outstanding)}
          tone={Number(balanceQ.data?.outstanding ?? 0) > 0 ? "warn" : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" /> Unified audit timeline
          </CardTitle>
          <CardDescription>
            Every FSM transition, audit-log entry, notification dispatch and
            remittance milestone for
            {" "}
            <span className="font-medium">
              {selectedOrder ? (selectedOrder as any).case_reference ?? (selectedOrder as any).id : "the selected order"}
            </span>
            . Read-only projection — all writes still route through the FSM.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {timelineQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading timeline…</div>
          ) : (timelineQ.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">No events recorded for this order yet.</div>
          ) : (
            <ol className="relative border-l pl-6 space-y-4">
              {(timelineQ.data ?? []).map((row, idx) => (
                <li key={`${row.source_table}:${row.source_row_id}:${idx}`} className="relative">
                  <span className="absolute -left-[29px] top-1 inline-flex h-6 w-6 items-center justify-center rounded-full border bg-background">
                    <KindIcon kind={row.entry_kind} />
                  </span>
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className="capitalize">
                      {row.entry_kind.replace("_", " ")}
                    </Badge>
                    <span className="font-medium">{row.action ?? "—"}</span>
                    <span className="text-muted-foreground">
                      {row.occurred_at ? new Date(row.occurred_at).toLocaleString() : ""}
                    </span>
                  </div>
                  {row.details ? (
                    <pre className="mt-1 text-xs bg-muted/40 rounded p-2 overflow-x-auto">
                      {JSON.stringify(row.details, null, 2)}
                    </pre>
                  ) : null}
                  <div className="mt-1 text-[11px] text-muted-foreground inline-flex items-center gap-1">
                    <ArrowUpRight className="h-3 w-3" /> {row.source_table}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BalanceKpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={
            "text-2xl font-semibold tabular-nums " +
            (tone === "warn" ? "text-amber-600" : "")
          }
        >
          {value}
        </div>
        {hint ? <div className="text-[11px] text-muted-foreground mt-1">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
