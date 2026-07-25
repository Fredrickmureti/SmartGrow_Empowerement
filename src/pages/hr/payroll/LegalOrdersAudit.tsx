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
import { useLegalRecipients } from "@/hooks/useLegalRecipients";
import { useEmployees } from "@/hooks/useEmployees";
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

const KIND_LABEL: Record<TimelineRow["entry_kind"], string> = {
  lifecycle_event: "Lifecycle",
  audit_log: "Audit",
  notification: "Notification",
  remittance_batch: "Remittance",
};

const KIND_TONE: Record<TimelineRow["entry_kind"], string> = {
  lifecycle_event: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20",
  audit_log: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  notification: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20",
  remittance_batch: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
};

function humanizeKey(k: string) {
  return k
    .replace(/_/g, " ")
    .replace(/\bid\b/gi, "ID")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function humanizeAction(a: string | null) {
  if (!a) return "—";
  return a
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONEY_KEYS = /(amount|owed|accrued|remitted|outstanding|balance|principal|interest|fee|total)/i;
const DATE_KEYS = /(_at|_on|date|period)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObj(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function formatValue(key: string, v: any, labels: Map<string, string>): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (MONEY_KEYS.test(key)) return fmt(v);
    return String(v);
  }
  if (typeof v === "string") {
    if (UUID_RE.test(v)) {
      const label = labels.get(v);
      return label ?? `#${v.slice(0, 8)}`;
    }
    if (DATE_KEYS.test(key) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        return v.length <= 10 ? d.toLocaleDateString() : d.toLocaleString();
      }
    }
    if (MONEY_KEYS.test(key) && /^-?\d+(\.\d+)?$/.test(v)) return fmt(Number(v));
    return v;
  }
  return JSON.stringify(v);
}

function DetailsGrid({ details, labels }: { details: Record<string, any>; labels: Map<string, string> }) {
  const entries = Object.entries(details).filter(
    ([k]) => !/^(organization_id|legal_order_id|tenant_id)$/i.test(k),
  );
  if (entries.length === 0) return null;
  const scalars = entries.filter(([, v]) => !isPlainObj(v) && !Array.isArray(v));
  const nested = entries.filter(([, v]) => isPlainObj(v) || Array.isArray(v));
  return (
    <div className="mt-2 space-y-2">
      {scalars.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm rounded-md border bg-muted/30 p-3">
          {scalars.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {humanizeKey(k)}
              </dt>
              <dd className={"tabular-nums " + (MONEY_KEYS.test(k) ? "font-medium" : "")}>
                {formatValue(k, v, labels)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {nested.map(([k, v]) => (
        <div key={k} className="rounded-md border bg-muted/30 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {humanizeKey(k)}
          </div>
          {Array.isArray(v) ? (
            <ul className="text-sm space-y-1 list-disc pl-4">
              {v.map((item, i) => (
                <li key={i}>{isPlainObj(item) || Array.isArray(item) ? JSON.stringify(item) : String(item)}</li>
              ))}
            </ul>
          ) : (
            <DetailsGrid details={v as Record<string, any>} labels={labels} />
          )}
        </div>
      ))}
    </div>
  );
}

function TimelineEntry({ row, index, labels }: { row: TimelineRow; index: number; labels: Map<string, string> }) {
  const [showRaw, setShowRaw] = useState(false);
  const hasDetails = row.details && Object.keys(row.details).length > 0;
  return (
    <li key={`${row.source_table}:${row.source_row_id}:${index}`} className="relative">
      <span className="absolute -left-[29px] top-1 inline-flex h-6 w-6 items-center justify-center rounded-full border bg-background">
        <KindIcon kind={row.entry_kind} />
      </span>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className={KIND_TONE[row.entry_kind]}>
          {KIND_LABEL[row.entry_kind]}
        </Badge>
        <span className="font-medium">{humanizeAction(row.action)}</span>
        <span className="text-muted-foreground">
          {row.occurred_at ? new Date(row.occurred_at).toLocaleString() : ""}
        </span>
      </div>
      {hasDetails && <DetailsGrid details={row.details as Record<string, any>} labels={labels} />}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ArrowUpRight className="h-3 w-3" /> {row.source_table}
        </span>
        {hasDetails && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => setShowRaw((s) => !s)}
          >
            {showRaw ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronRight className="h-3 w-3 mr-1" />}
            {showRaw ? "Hide raw" : "View raw"}
          </Button>
        )}
      </div>
      {showRaw && hasDetails && (
        <pre className="mt-1 text-xs bg-muted/40 rounded p-2 overflow-x-auto">
          {JSON.stringify(row.details, null, 2)}
        </pre>
      )}
    </li>
  );
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
            <ol className="relative border-l pl-6 space-y-5">
              {(timelineQ.data ?? []).map((row, idx) => (
                <TimelineEntry
                  key={`${row.source_table}:${row.source_row_id}:${idx}`}
                  row={row}
                  index={idx}
                />
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
