/**
 * Legal Orders — Audit tab.
 *
 * Renders through the shared audit-log primitives (`AuditLogTableView` +
 * `AuditEntryDrawer`) so this tab reads identically to the Activity tab
 * on /settings/audit-logs. The order picker + "Balance as of" + running
 * balance KPIs stay above the table since they provide domain context.
 *
 * Data source: `v_legal_order_audit_timeline` (security_invoker) which
 * unions lifecycle events, audit log entries, notification dispatches
 * and remittance batch milestones. Point-in-time balance comes from
 * `legal_order_running_balance`.
 *
 * Read-only projection — writes still route through the FSM.
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Activity, ArrowUpRight, Banknote, Bell, ClipboardList, ShieldAlert } from "lucide-react";
import { AuditLogTableView, type AuditEntry, type AuditActionTone } from "@/components/audit/AuditLogTableView";
import { AuditEntryDrawer, SummaryItem } from "@/components/audit/AuditEntryDrawer";
import { format } from "date-fns";

type EntryKind = "lifecycle_event" | "audit_log" | "notification" | "remittance_batch";

type TimelineRow = {
  organization_id: string;
  legal_order_id: string;
  occurred_at: string | null;
  entry_kind: EntryKind;
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

const KIND_LABEL: Record<EntryKind, string> = {
  lifecycle_event: "Lifecycle",
  audit_log: "Audit",
  notification: "Notification",
  remittance_batch: "Remittance",
};

const KIND_TONE: Record<EntryKind, AuditActionTone> = {
  lifecycle_event: "info",
  audit_log: "warning",
  notification: "neutral",
  remittance_batch: "success",
};

function KindIcon({ kind }: { kind: EntryKind }) {
  const cls = "h-4 w-4";
  switch (kind) {
    case "lifecycle_event":
      return <Activity className={cls} />;
    case "remittance_batch":
      return <Banknote className={cls} />;
    case "notification":
      return <Bell className={cls} />;
    case "audit_log":
      return <ShieldAlert className={cls} />;
    default:
      return <ClipboardList className={cls} />;
  }
}

function humanizeKey(k: string) {
  return k.replace(/_/g, " ").replace(/\bid\b/gi, "ID").replace(/^\w/, (c) => c.toUpperCase());
}

function humanizeAction(a: string | null) {
  if (!a) return "—";
  return a.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
  if (typeof v === "number") return MONEY_KEYS.test(key) ? fmt(v) : String(v);
  if (typeof v === "string") {
    if (UUID_RE.test(v)) {
      const label = labels.get(v);
      return label ?? `#${v.slice(0, 8)}`;
    }
    if (DATE_KEYS.test(key) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return v.length <= 10 ? d.toLocaleDateString() : d.toLocaleString();
    }
    if (MONEY_KEYS.test(key) && /^-?\d+(\.\d+)?$/.test(v)) return fmt(Number(v));
    return v;
  }
  return JSON.stringify(v);
}

function DetailsGrid({
  details,
  labels,
}: {
  details: Record<string, any>;
  labels: Map<string, string>;
}) {
  const entries = Object.entries(details).filter(
    ([k]) => !/^(organization_id|legal_order_id|tenant_id)$/i.test(k),
  );
  if (entries.length === 0) return null;
  const scalars = entries.filter(([, v]) => !isPlainObj(v) && !Array.isArray(v));
  const nested = entries.filter(([, v]) => isPlainObj(v) || Array.isArray(v));
  return (
    <div className="space-y-2 min-w-0">
      {scalars.length > 0 && (
        <div className="overflow-x-auto rounded-md border bg-muted/30">
          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm p-3">
            {scalars.map(([k, v]) => (
              <div key={k} className="flex flex-col min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                  {humanizeKey(k)}
                </dt>
                <dd
                  className={
                    "tabular-nums break-words " + (MONEY_KEYS.test(k) ? "font-medium" : "")
                  }
                >
                  {formatValue(k, v, labels)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {nested.map(([k, v]) => (
        <div key={k} className="rounded-md border bg-muted/30 p-3 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            {humanizeKey(k)}
          </div>
          {Array.isArray(v) ? (
            <ul className="text-sm space-y-1 list-disc pl-4 break-words">
              {v.map((item, i) => (
                <li key={i}>
                  {isPlainObj(item) || Array.isArray(item) ? JSON.stringify(item) : String(item)}
                </li>
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

function shortSummary(row: TimelineRow): string {
  const details = row.details ?? {};
  const bits: string[] = [];
  for (const k of ["from_status", "to_status", "amount", "outstanding", "status"]) {
    if (details[k] !== undefined && details[k] !== null && details[k] !== "") {
      bits.push(`${humanizeKey(k)}: ${details[k]}`);
    }
  }
  const base = humanizeAction(row.action);
  return bits.length > 0 ? `${base} — ${bits.join(", ")}` : base;
}

function toAuditEntry(row: TimelineRow, labels: Map<string, string>, idx: number): AuditEntry {
  const kind = row.entry_kind;
  return {
    id: `${row.source_table}:${row.source_row_id}:${idx}`,
    occurredAt: row.occurred_at ?? new Date(0).toISOString(),
    userLabel: row.actor_user_id ? labels.get(row.actor_user_id) ?? null : null,
    action: { label: humanizeAction(row.action), tone: KIND_TONE[kind] },
    entity: { label: KIND_LABEL[kind], raw: row.source_table ?? kind },
    entityName: row.source_table ?? null,
    summary: shortSummary(row),
    raw: row,
  };
}

export default function LegalOrdersAudit() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const { data: orders = [] } = useLegalOrders();
  const { data: recipients = [] } = useLegalRecipients();
  const { employees } = useEmployees();

  const [selectedOrderId, setSelectedOrderId] = useState<string | "">("");
  const [asOf, setAsOf] = useState<string>(new Date().toISOString().slice(0, 10));
  const [selectedRow, setSelectedRow] = useState<TimelineRow | null>(null);

  const activeOrderId = selectedOrderId || (orders[0]?.id ?? "");

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees ?? []) {
      const label =
        [(e as any).first_name, (e as any).last_name].filter(Boolean).join(" ").trim() ||
        (e as any).full_name ||
        (e as any).employee_number ||
        "Employee";
      m.set(e.id, label);
    }
    for (const r of recipients ?? []) {
      m.set(r.id, r.display_name);
      if (r.authority_id && (r as any).authority_name) m.set(r.authority_id, (r as any).authority_name);
    }
    for (const o of orders ?? []) {
      const anyO = o as any;
      const label = anyO.case_reference || anyO.order_reference || anyO.kind_code || null;
      if (label) m.set(o.id, label);
    }
    return m;
  }, [employees, recipients, orders]);

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
      const { data, error } = await (supabase as any).rpc("legal_order_running_balance", {
        _organization_id: orgId,
        _legal_order_id: activeOrderId,
        _as_of: asOf,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as RunningBalance | null;
    },
  });

  const selectedOrder = useMemo(
    () => orders.find((o: any) => o.id === activeOrderId),
    [orders, activeOrderId],
  );

  const rows: AuditEntry[] = useMemo(
    () => (timelineQ.data ?? []).map((r, i) => toAuditEntry(r, labels, i)),
    [timelineQ.data, labels],
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 min-w-0">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Legal order</label>
          <Select value={activeOrderId} onValueChange={setSelectedOrderId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Pick a legal order" />
            </SelectTrigger>
            <SelectContent>
              {orders.map((o: any) => (
                <SelectItem key={o.id} value={o.id}>
                  {(o.case_reference || o.kind_code || o.id) +
                    " — " +
                    (o.authority_name ?? o.employee_id ?? "")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Balance as of</label>
          <Input type="date" className="mt-1" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
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
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Unified audit timeline
          </CardTitle>
          <CardDescription>
            Every FSM transition, audit-log entry, notification dispatch and remittance milestone for{" "}
            <span className="font-medium">
              {selectedOrder
                ? (selectedOrder as any).case_reference ?? (selectedOrder as any).id
                : "the selected order"}
            </span>
            . Read-only projection — all writes still route through the FSM.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AuditLogTableView
            entries={rows}
            isLoading={timelineQ.isLoading}
            onSelect={(entry) => setSelectedRow(entry.raw as TimelineRow)}
            emptyTitle="No events recorded for this order yet"
            emptyHint="Lifecycle transitions, audit entries, notifications and remittance milestones will appear here."
          />
        </CardContent>
      </Card>

      <AuditEntryDrawer
        entry={
          selectedRow
            ? toAuditEntry(selectedRow, labels, 0)
            : null
        }
        onClose={() => setSelectedRow(null)}
        rawJson={selectedRow?.details ?? undefined}
        copyId={selectedRow?.source_row_id ?? undefined}
        extraSummary={
          selectedRow
            ? [
                {
                  label: "Source",
                  value: (
                    <span className="inline-flex items-center gap-1 text-xs">
                      <KindIcon kind={selectedRow.entry_kind} />
                      <span className="font-mono">{selectedRow.source_table ?? "—"}</span>
                    </span>
                  ),
                },
                {
                  label: "When",
                  value: selectedRow.occurred_at
                    ? format(new Date(selectedRow.occurred_at), "MMM d, yyyy HH:mm:ss")
                    : "—",
                },
                ...(selectedRow.source_row_id
                  ? [
                      {
                        label: "Source ID",
                        value: <span className="font-mono text-xs">{selectedRow.source_row_id}</span>,
                      },
                    ]
                  : []),
              ]
            : undefined
        }
      >
        {selectedRow && selectedRow.details && Object.keys(selectedRow.details).length > 0 && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              Details
            </div>
            <DetailsGrid details={selectedRow.details} labels={labels} />
          </div>
        )}
      </AuditEntryDrawer>
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
            "text-2xl font-semibold tabular-nums " + (tone === "warn" ? "text-amber-600" : "")
          }
        >
          {value}
        </div>
        {hint ? <div className="text-[11px] text-muted-foreground mt-1">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
