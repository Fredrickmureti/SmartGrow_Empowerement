/**
 * <ExceptionDetailSheet /> — Phase 5 of the Exceptions command centre.
 *
 * The single drill-down surface for one exception. It reads the canonical
 * satellites written by the Phase 1 domain model:
 *   - `wms_exception_events`   → immutable lifecycle history
 *   - `wms_exception_evidence` → structured proof (scans, photos, readings)
 *   - `wms_exception_links`    → related documents with deep-link routes
 *   - `wms_exception_policies` → the routing/SLA/evidence contract in force
 *
 * Mutations go exclusively through the RPCs so optimistic locking
 * (`row_version`), policy evidence gates, and the notification bridge all
 * stay authoritative in the database.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { LoadingState, StatusBadge } from "@/design-system";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  ExceptionRow, ExceptionState, OwnerRole, ResolutionKind, EvidenceType,
  OWNER_ROLES, RESOLUTION_KINDS, EVIDENCE_TYPES, STATE_TONE, CLASS_TONE,
  severityTone, severityLabel, humanise, shortDuration, TERMINAL_STATES,
} from "./constants";

interface EventRow {
  id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor_id: string | null;
  actor_role: string | null;
  reason: string | null;
  occurred_at: string;
}

interface EvidenceRow {
  id: string;
  evidence_type: EvidenceType;
  label: string | null;
  numeric_value: number | null;
  unit: string | null;
  text_value: string | null;
  external_url: string | null;
  storage_path: string | null;
  captured_at: string;
}

/**
 * Where the work actually lives.
 *
 * An exception is only workable if the supervisor can reach the thing that
 * went wrong. `wms_exception_links.route_path` covers curated links; this
 * map is the fallback for the aggregates the raisers stamp, so every
 * exception offers a way back onto the floor instead of a bare UUID.
 */
const AGGREGATE_ROUTES: Record<string, (id: string) => string> = {
  wms_task: () => "/warehouse-app/tasks",
  wms_license_plate: () => "/warehouse-app/lpns",
  wms_qc_inspection: (id) => `/warehouse-app/qc/${id}`,
  wms_count_line: () => "/warehouse-app/counts",
  wms_count_session: (id) => `/warehouse-app/counts/${id}`,
  wms_dock_appointment: () => "/warehouse-app/schedule",
  wms_trailer_visit: (id) => `/warehouse-app/yard/visit/${id}`,
  wms_receiving_line: () => "/warehouse-app/receiving",
  wms_receiving_session: () => "/warehouse-app/receiving",
  wms_return_line: () => "/warehouse-app/returns",
  wms_return_order: () => "/warehouse-app/returns",
  wms_loading_manifest: (id) => `/warehouse-app/dispatch/${id}`,
  wms_pick_wave: () => "/warehouse-app/waves",
  stock_quant: () => "/inventory-app/stock",
};

function aggregateRoute(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  const build = AGGREGATE_ROUTES[type];
  return build ? build(id) : null;
}

interface LinkRow {
  id: string;
  link_type: string;
  record_id: string | null;
  record_label: string | null;
  route_path: string | null;
}

interface PolicyRow {
  sla_minutes: number | null;
  owner_role: OwnerRole | null;
  escalation_after_mins: number | null;
  escalation_role: OwnerRole | null;
  max_escalation_level: number | null;
  requires_evidence: boolean | null;
  required_evidence_types: string[] | null;
}

export interface ExceptionDetailSheetProps {
  exception: ExceptionRow | null;
  currentUserId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function ExceptionDetailSheet({
  exception, currentUserId, onOpenChange,
}: ExceptionDetailSheetProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workItemRoute = aggregateRoute(exception?.aggregate_type ?? null, exception?.aggregate_id ?? null);
  const id = exception?.id ?? null;

  const [resolution, setResolution] = useState("");
  const [resolutionKind, setResolutionKind] = useState<ResolutionKind | "">("");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("note");
  const [evidenceLabel, setEvidenceLabel] = useState("");
  const [evidenceValue, setEvidenceValue] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
    qc.invalidateQueries({ queryKey: ["wms_exception_detail"] });
  };

  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ["wms_exception_detail", "events", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exception_events" as any)
        .select("id, event_type, from_state, to_state, actor_id, actor_role, reason, occurred_at")
        .eq("exception_id", id)
        .order("occurred_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as EventRow[];
    },
  });

  const { data: evidence = [] } = useQuery({
    queryKey: ["wms_exception_detail", "evidence", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exception_evidence" as any)
        .select("id, evidence_type, label, numeric_value, unit, text_value, external_url, storage_path, captured_at")
        .eq("exception_id", id)
        .order("captured_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as EvidenceRow[];
    },
  });

  const { data: links = [] } = useQuery({
    queryKey: ["wms_exception_detail", "links", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exception_links" as any)
        .select("id, link_type, record_id, record_label, route_path")
        .eq("exception_id", id);
      if (error) throw error;
      return (data ?? []) as unknown as LinkRow[];
    },
  });

  const { data: policy } = useQuery({
    queryKey: ["wms_exception_detail", "policy", exception?.kind, exception?.warehouse_id],
    enabled: !!exception,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exception_policies" as any)
        .select("sla_minutes, owner_role, escalation_after_mins, escalation_role, max_escalation_level, requires_evidence, required_evidence_types, warehouse_id")
        .eq("kind", exception!.kind)
        .eq("is_active", true)
        .order("warehouse_id", { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as unknown as PolicyRow | null;
    },
  });

  const rpc = useMutation({
    mutationFn: async (input: { fn: string; args: Record<string, unknown> }) => {
      const { error } = await supabase.rpc(input.fn as any, input.args);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Exception updated"); invalidate(); onOpenChange(false); },
    onError: (e: any) => toast.error(e?.message ?? "Could not update exception"),
  });

  const addEvidence = useMutation({
    mutationFn: async () => {
      if (!exception) return;
      const numeric = Number(evidenceValue);
      const isNumeric = evidenceValue.trim() !== "" && !Number.isNaN(numeric)
        && ["weight", "dimension", "temperature", "humidity", "sensor_reading"].includes(evidenceType);
      const { error } = await supabase.from("wms_exception_evidence" as any).insert({
        organization_id: exception.organization_id,
        business_id: exception.business_id,
        exception_id: exception.id,
        evidence_type: evidenceType,
        label: evidenceLabel.trim() || null,
        numeric_value: isNumeric ? numeric : null,
        text_value: isNumeric ? null : (evidenceValue.trim() || null),
        captured_by: currentUserId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Evidence captured");
      setEvidenceLabel(""); setEvidenceValue("");
      qc.invalidateQueries({ queryKey: ["wms_exception_detail"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save evidence"),
  });

  if (!exception) return null;
  const e = exception;
  const closed = TERMINAL_STATES.includes(e.state);
  const overdue = !!e.due_by && !closed && new Date(e.due_by).getTime() < Date.now();
  const evidenceMissing =
    !!policy?.requires_evidence &&
    (policy.required_evidence_types ?? []).some(
      (t) => !evidence.some((ev) => ev.evidence_type === t),
    );

  const transition = (to: ExceptionState) =>
    rpc.mutate({
      fn: "wms_resolve_exception",
      args: {
        p_exception_id: e.id,
        p_to_state: to,
        p_row_version: e.row_version,
        p_resolution: resolution.trim() || null,
        p_resolution_kind: resolutionKind || null,
      },
    });

  return (
    <Sheet open={!!exception} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {humanise(e.kind)}
            <StatusBadge tone={STATE_TONE[e.state]}>{humanise(e.state)}</StatusBadge>
            <StatusBadge tone={severityTone(e.severity)}>{severityLabel(e.severity)}</StatusBadge>
            {e.class && <StatusBadge tone={CLASS_TONE[e.class]}>{humanise(e.class)}</StatusBadge>}
            {(e.escalation_level ?? 0) > 0 && (
              <StatusBadge tone="danger">L{e.escalation_level} escalation</StatusBadge>
            )}
          </SheetTitle>
          <SheetDescription>{e.reason ?? "No reason recorded."}</SheetDescription>
        </SheetHeader>

        <div className="min-w-0 mt-4 grid grid-cols-2 gap-3 text-sm">
          <Field label="Owner role" value={humanise(e.owner_role)} />
          <Field
            label="SLA"
            value={
              closed ? "closed"
                : e.due_by
                  ? `${shortDuration(new Date(e.due_by).getTime() - Date.now())} ${overdue ? "overdue" : "left"}`
                  : "—"
            }
            tone={overdue ? "danger" : undefined}
          />
          <Field label="Raised" value={new Date(e.created_at).toLocaleString()} />
          <Field label="Acknowledged" value={e.acknowledged_at ? new Date(e.acknowledged_at).toLocaleString() : "—"} />
          <Field label="Source" value={humanise(e.source_system) } />
          <Field
            label="Financial impact"
            value={e.financial_impact ? `${e.impact_currency ?? ""} ${Number(e.financial_impact).toLocaleString()}`.trim() : "—"}
          />
          <Field
            label="Aggregate"
            value={`${humanise(e.aggregate_type)}${e.aggregate_id ? ` · ${e.aggregate_id.slice(0, 8)}` : ""}`}
            action={
              workItemRoute
                ? { label: "Open work item", onClick: () => { onOpenChange(false); navigate(workItemRoute); } }
                : undefined
            }
          />
          <Field label="Assigned" value={e.assigned_to ? (e.assigned_to === currentUserId ? "You" : `${e.assigned_to.slice(0, 8)}…`) : "Unassigned"} />
        </div>

        {policy && (
          <p className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Policy: {policy.sla_minutes ?? "—"}m SLA, routed to {humanise(policy.owner_role)}
            {policy.escalation_after_mins ? `, escalates after ${policy.escalation_after_mins}m to ${humanise(policy.escalation_role)} (max L${policy.max_escalation_level ?? 1})` : ""}
            {policy.requires_evidence
              ? `. Evidence required: ${(policy.required_evidence_types ?? []).map(humanise).join(", ") || "any"}.`
              : ". No evidence gate."}
          </p>
        )}

        {!closed && (
          <div className="mt-4 flex flex-wrap gap-2">
            {!e.acknowledged_at && (
              <Button
                size="sm" variant="outline" disabled={rpc.isPending}
                onClick={() => rpc.mutate({
                  fn: "wms_acknowledge_exception",
                  args: { p_exception_id: e.id, p_row_version: e.row_version, p_note: null },
                })}
              >
                Acknowledge
              </Button>
            )}
            {e.assigned_to !== currentUserId && currentUserId && (
              <Button
                size="sm" variant="outline" disabled={rpc.isPending}
                onClick={() => rpc.mutate({
                  fn: "wms_assign_exception",
                  args: {
                    p_exception_id: e.id, p_row_version: e.row_version,
                    p_assignee: currentUserId, p_owner_role: null,
                    p_reason: "Self-assigned from Exceptions Inbox",
                  },
                })}
              >
                Assign to me
              </Button>
            )}
            <Select
              onValueChange={(v) => rpc.mutate({
                fn: "wms_assign_exception",
                args: {
                  p_exception_id: e.id, p_row_version: e.row_version,
                  p_assignee: null, p_owner_role: v as OwnerRole,
                  p_reason: "Reassigned from Exceptions Inbox",
                },
              })}
            >
              <SelectTrigger className="h-9 w-52"><SelectValue placeholder="Route to role…" /></SelectTrigger>
              <SelectContent>
                {OWNER_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{humanise(r)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Separator className="my-4" />

        <Tabs defaultValue="history">
          <TabsList>
            <TabsTrigger value="history">History ({events.length})</TabsTrigger>
            <TabsTrigger value="evidence">Evidence ({evidence.length})</TabsTrigger>
            <TabsTrigger value="links">Linked ({links.length})</TabsTrigger>
            {!closed && <TabsTrigger value="close">Close out</TabsTrigger>}
          </TabsList>

          <TabsContent value="history" className="pt-3">
            {eventsLoading ? <LoadingState /> : events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No lifecycle events recorded yet.</p>
            ) : (
              <ol className="space-y-2">
                {events.map((ev) => (
                  <li key={ev.id} className="rounded-md border border-border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{humanise(ev.event_type)}</span>
                      <span className="text-muted-foreground">{new Date(ev.occurred_at).toLocaleString()}</span>
                    </div>
                    {(ev.from_state || ev.to_state) && (
                      <div className="text-muted-foreground">
                        {humanise(ev.from_state)} → {humanise(ev.to_state)}
                      </div>
                    )}
                    {ev.reason && <div className="mt-1">{ev.reason}</div>}
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="evidence" className="space-y-3 pt-3">
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">No evidence captured.</p>
            ) : (
              <ul className="space-y-2">
                {evidence.map((ev) => (
                  <li key={ev.id} className="rounded-md border border-border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{humanise(ev.evidence_type)}</span>
                      <span className="text-muted-foreground">{new Date(ev.captured_at).toLocaleString()}</span>
                    </div>
                    <div>
                      {ev.label ? `${ev.label}: ` : ""}
                      {ev.numeric_value !== null
                        ? `${ev.numeric_value}${ev.unit ? ` ${ev.unit}` : ""}`
                        : ev.text_value ?? ev.external_url ?? ev.storage_path ?? "—"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!closed && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <Label className="text-xs">Capture evidence</Label>
                <div className="flex gap-2">
                  <Select value={evidenceType} onValueChange={(v) => setEvidenceType(v as EvidenceType)}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {EVIDENCE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{humanise(t)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Label (optional)"
                    value={evidenceLabel}
                    onChange={(ev) => setEvidenceLabel(ev.target.value)}
                  />
                </div>
                <Input
                  placeholder="Value / reading / note"
                  value={evidenceValue}
                  onChange={(ev) => setEvidenceValue(ev.target.value)}
                />
                <Button
                  size="sm"
                  disabled={addEvidence.isPending || !evidenceValue.trim()}
                  onClick={() => addEvidence.mutate()}
                >
                  Add evidence
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="links" className="pt-3">
            {links.length === 0 ? (
              <p className="text-sm text-muted-foreground">No linked records.</p>
            ) : (
              <ul className="space-y-2">
                {links.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-xs">
                    <span>
                      <span className="text-muted-foreground">{humanise(l.link_type)}: </span>
                      {l.record_label ?? l.record_id?.slice(0, 8) ?? "—"}
                    </span>
                    {l.route_path && (
                      <Button size="sm" variant="ghost" onClick={() => navigate(l.route_path!)}>Open</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          {!closed && (
            <TabsContent value="close" className="space-y-3 pt-3">
              <div>
                <Label htmlFor="cause">Cause</Label>
                <Select value={resolutionKind} onValueChange={(v) => setResolutionKind(v as ResolutionKind)}>
                  <SelectTrigger id="cause"><SelectValue placeholder="Categorise the cause" /></SelectTrigger>
                  <SelectContent>
                    {RESOLUTION_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{humanise(k)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Drives the recurrence analytics — required before closing.
                </p>
              </div>
              <Textarea
                rows={4}
                placeholder="Resolution notes (what did you do?)"
                value={resolution}
                onChange={(ev) => setResolution(ev.target.value)}
              />
              {evidenceMissing && (
                <p className="text-xs text-destructive">
                  Policy requires {(policy?.required_evidence_types ?? []).map(humanise).join(", ")} evidence before this can be closed.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={rpc.isPending} onClick={() => transition("investigating")}>
                  Investigating
                </Button>
                <Button variant="outline" disabled={rpc.isPending} onClick={() => transition("escalated")}>
                  Escalate
                </Button>
                <Button
                  variant="outline"
                  disabled={rpc.isPending || !resolutionKind || !resolution.trim()}
                  onClick={() => transition("wont_fix")}
                >
                  Won't fix
                </Button>
                <Button
                  disabled={rpc.isPending || !resolutionKind || !resolution.trim()}
                  onClick={() => transition("resolved")}
                >
                  Resolve
                </Button>
              </div>
            </TabsContent>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label, value, tone, action,
}: {
  label: string;
  value: string;
  tone?: "danger";
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("font-medium", tone === "danger" && "text-destructive")}>{value}</div>
      {action && (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
