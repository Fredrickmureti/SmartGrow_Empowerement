/**
 * Exceptions Inbox — the operational nerve centre for abnormal warehouse events.
 *
 * Exceptions are a shared enterprise service, not a per-subsystem afterthought:
 *   - Detection: database triggers + a scheduled sweep raise every abnormal
 *     event through `wms_raise_exception` (idempotent, policy-driven).
 *   - Routing: `wms_exception_policies` stamp class, severity, owner role,
 *     SLA due date and the evidence contract at raise time.
 *   - Lifecycle: `wms_assign_exception` / `wms_acknowledge_exception` /
 *     `wms_resolve_exception` move the FSM under optimistic locking, while
 *     `wms_escalate_overdue_exceptions` sweeps breaches on a cron.
 *   - Distribution: every transition notifies owners and subscribers and
 *     publishes `warehouse.exception.*` onto the business event outbox.
 *
 * This page is the human surface over that service: triage queue, deep
 * drill-down, and recurrence analytics.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWarehouses } from "@/hooks/useWarehouses";
import { ShieldCheck, BellRing, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { ExceptionDetailSheet } from "@/features/warehouse/exceptions/ExceptionDetailSheet";
import { ExceptionAnalytics } from "@/features/warehouse/exceptions/ExceptionAnalytics";
import {
  ExceptionRow, ExceptionState, EXCEPTION_CLASSES, OWNER_ROLES, OPEN_STATES,
  TERMINAL_STATES, STATE_TONE, CLASS_TONE, severityTone, severityLabel,
  humanise, shortDuration,
} from "@/features/warehouse/exceptions/constants";

function SlaCell({ dueBy, state }: { dueBy: string | null; state: ExceptionState }) {
  if (TERMINAL_STATES.includes(state)) return <span className="text-muted-foreground">closed</span>;
  if (!dueBy) return <span className="text-muted-foreground">—</span>;
  const delta = new Date(dueBy).getTime() - Date.now();
  const overdue = delta < 0;
  const soon = !overdue && delta <= 30 * 60000;
  return (
    <span
      className={cn("font-medium", overdue ? "text-destructive" : soon ? "text-warning" : "text-muted-foreground")}
      title={new Date(dueBy).toLocaleString()}
    >
      {shortDuration(delta)} {overdue ? "overdue" : "left"}
    </span>
  );
}

export default function ExceptionsInbox() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState("");
  const [stateFilter, setStateFilter] = useState("open_all");
  const [classFilter, setClassFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<ExceptionRow | null>(null);

  /**
   * Deep link support — `?exception=<id>`.
   *
   * The Outbound Control Tower (and any notification) links to a specific
   * exception. Fetch it by id rather than hunting the filtered list: a
   * supervisor following an escalation must land on the row even when the
   * inbox's current filters, warehouse or SLA scope would hide it.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("exception");

  const { data: focused } = useQuery({
    queryKey: ["wms_exception_focus", focusId],
    enabled: !!focusId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exceptions" as any)
        .select("*")
        .eq("id", focusId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as ExceptionRow | null;
    },
  });

  useEffect(() => {
    if (focused && (!active || active.id !== focused.id)) setActive(focused);
    // Only react to a newly resolved deep link, not to every sheet change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const closeDetail = () => {
    setActive(null);
    if (focusId) {
      const next = new URLSearchParams(searchParams);
      next.delete("exception");
      setSearchParams(next, { replace: true });
    }
  };

  const effectiveWh = warehouseId || warehouses[0]?.id || "";

  const { data: userId = null } = useQuery({
    queryKey: ["auth-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: 5 * 60_000,
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["wms_exceptions", effectiveWh, stateFilter, classFilter, roleFilter, severityFilter, scope, userId],
    enabled: !!effectiveWh,
    refetchInterval: 60_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_exceptions" as any)
        .select("*")
        .eq("warehouse_id", effectiveWh)
        .order("severity", { ascending: false })
        .order("due_by", { ascending: true, nullsFirst: false })
        .limit(400);
      if (stateFilter === "open_all") q = q.in("state", OPEN_STATES);
      else if (stateFilter === "overdue") {
        q = q.in("state", OPEN_STATES).lt("due_by", new Date().toISOString());
      } else if (stateFilter !== "all") q = q.eq("state", stateFilter);
      if (classFilter !== "all") q = q.eq("class", classFilter);
      if (roleFilter !== "all") q = q.eq("owner_role", roleFilter);
      if (severityFilter !== "all") q = q.gte("severity", Number(severityFilter));
      if (scope === "mine" && userId) q = q.eq("assigned_to", userId);
      if (scope === "unassigned") q = q.is("assigned_to", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ExceptionRow[];
    },
  });

  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(
      (r) =>
        r.kind.toLowerCase().includes(t) ||
        (r.reason ?? "").toLowerCase().includes(t) ||
        (r.aggregate_type ?? "").toLowerCase().includes(t) ||
        (r.aggregate_id ?? "").toLowerCase().includes(t),
    );
  }, [rows, search]);

  const summary = useMemo(() => {
    const now = Date.now();
    return {
      total: rows.length,
      overdue: rows.filter((r) => !TERMINAL_STATES.includes(r.state) && r.due_by && new Date(r.due_by).getTime() < now).length,
      escalated: rows.filter((r) => (r.escalation_level ?? 0) > 0).length,
      unassigned: rows.filter((r) => !r.assigned_to).length,
      critical: rows.filter((r) => r.severity >= 4 && !TERMINAL_STATES.includes(r.state)).length,
      unacked: rows.filter((r) => !r.acknowledged_at && !TERMINAL_STATES.includes(r.state)).length,
    };
  }, [rows]);

  const { data: subscription } = useQuery({
    queryKey: ["wms_exception_subscription", effectiveWh, userId],
    enabled: !!effectiveWh && !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exception_subscriptions" as any)
        .select("id, active")
        .eq("user_id", userId)
        .eq("warehouse_id", effectiveWh)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as { id: string; active: boolean } | null;
    },
  });

  const anchor = rows[0];
  const toggleSubscription = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      if (subscription) {
        const { error } = await supabase
          .from("wms_exception_subscriptions" as any)
          .update({ active: !subscription.active })
          .eq("id", subscription.id);
        if (error) throw error;
        return;
      }
      if (!anchor) throw new Error("Subscribe once at least one exception exists for this warehouse");
      const { error } = await supabase.from("wms_exception_subscriptions" as any).insert({
        organization_id: anchor.organization_id,
        business_id: anchor.business_id,
        warehouse_id: effectiveWh,
        user_id: userId,
        min_severity: 3,
        active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Alert preferences updated");
      qc.invalidateQueries({ queryKey: ["wms_exception_subscription"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update alerts"),
  });

  const subscribed = !!subscription?.active;

  return (
    <>
      <PageHeader
        title="Exceptions Inbox"
        description="Every abnormal warehouse event — receiving variances, QC fails, count discrepancies, stalled tasks, negative stock, yard and device faults — is detected at source, routed by policy, and closed here against an SLA."
      />
      <PageBody>
        <div className="min-w-0 mb-4 grid grid-cols-2 gap-3 @2xl/page:grid-cols-6">
          <Tile label="In view" value={summary.total} />
          <Tile label="Overdue" value={summary.overdue} tone={summary.overdue ? "danger" : undefined} />
          <Tile label="Escalated" value={summary.escalated} tone={summary.escalated ? "danger" : undefined} />
          <Tile label="Critical" value={summary.critical} tone={summary.critical ? "danger" : undefined} />
          <Tile label="Unacknowledged" value={summary.unacked} tone={summary.unacked ? "warning" : undefined} />
          <Tile label="Unassigned" value={summary.unassigned} />
        </div>

        <Tabs defaultValue="queue">
          <TabsList className="mb-4">
            <TabsTrigger value="queue">Triage queue</TabsTrigger>
            <TabsTrigger value="analytics">Recurrence &amp; SLA</TabsTrigger>
          </TabsList>

          <TabsContent value="queue">
            <Section
              title="Queue"
              actions={
                <div className="flex flex-wrap gap-2">
                  <Select value={effectiveWh} onValueChange={setWarehouseId}>
                    <SelectTrigger className="w-48"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant={subscribed ? "default" : "outline"}
                    size="sm"
                    disabled={toggleSubscription.isPending || !userId}
                    onClick={() => toggleSubscription.mutate()}
                  >
                    {subscribed ? <BellRing className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}
                    {subscribed ? "Alerts on" : "Alert me"}
                  </Button>
                </div>
              }
            >
              <div className="mb-4 flex flex-wrap gap-2">
                <Input
                  className="w-56"
                  placeholder="Search kind, reason, reference…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Select value={stateFilter} onValueChange={setStateFilter}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open_all">Open (default)</SelectItem>
                    <SelectItem value="overdue">Overdue only</SelectItem>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="acknowledged">Acknowledged</SelectItem>
                    <SelectItem value="investigating">Investigating</SelectItem>
                    <SelectItem value="escalated">Escalated</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="wont_fix">Won't fix</SelectItem>
                    <SelectItem value="all">All states</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={classFilter} onValueChange={setClassFilter}>
                  <SelectTrigger className="w-40"><SelectValue placeholder="Class" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All classes</SelectItem>
                    {EXCEPTION_CLASSES.map((c) => (
                      <SelectItem key={c} value={c}>{humanise(c)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="w-48"><SelectValue placeholder="Owner role" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All owners</SelectItem>
                    {OWNER_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{humanise(r)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={severityFilter} onValueChange={setSeverityFilter}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any severity</SelectItem>
                    <SelectItem value="2">Medium +</SelectItem>
                    <SelectItem value="3">High +</SelectItem>
                    <SelectItem value="4">Critical</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Everyone</SelectItem>
                    <SelectItem value="mine">Assigned to me</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isLoading ? (
                <LoadingState />
              ) : visible.length === 0 ? (
                <EmptyState icon={ShieldCheck} title="Nothing to triage" description="No exceptions match your filter." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Exception</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>SLA</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((r) => (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer"
                        onClick={() => setActive(r)}
                      >
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(r.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{humanise(r.kind)}</div>
                          <div className="max-w-sm truncate text-muted-foreground">{r.reason}</div>
                        </TableCell>
                        <TableCell>
                          {r.class ? <StatusBadge tone={CLASS_TONE[r.class]}>{humanise(r.class)}</StatusBadge> : "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{humanise(r.owner_role)}</div>
                          <div className="text-muted-foreground">
                            {r.assigned_to ? (r.assigned_to === userId ? "You" : "Assigned") : "Unassigned"}
                          </div>
                        </TableCell>
                        <TableCell><StatusBadge tone={severityTone(r.severity)}>{severityLabel(r.severity)}</StatusBadge></TableCell>
                        <TableCell>
                          <StatusBadge tone={STATE_TONE[r.state]}>{humanise(r.state)}</StatusBadge>
                          {(r.escalation_level ?? 0) > 0 && (
                            <div className="mt-1 text-[10px] font-medium text-destructive">L{r.escalation_level}</div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <SlaCell dueBy={r.due_by} state={r.state} />
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="outline" onClick={() => setActive(r)}>Open</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="analytics">
            <Section title="Recurrence, causes and SLA performance">
              <ExceptionAnalytics warehouseId={effectiveWh} />
            </Section>
          </TabsContent>
        </Tabs>
      </PageBody>

      <ExceptionDetailSheet
        exception={active}
        currentUserId={userId}
        onOpenChange={(o) => { if (!o) closeDetail(); }}
      />
    </>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-2xl font-semibold",
          tone === "danger" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
    </div>
  );
}
