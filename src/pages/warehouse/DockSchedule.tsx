/**
 * DockSchedule — read-only per-warehouse day view of dock appointments.
 *
 * Writes flow through the sanctioned RPCs (`mark_appointment_arrived`,
 * `start_appointment`, `complete_dock_appointment`,
 * `cancel_dock_appointment`). Creation lives in
 * `AppointmentPlanner.tsx`.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CalendarClock, Plus } from "lucide-react";

interface Warehouse { id: string; name: string; business_id: string; }
interface Dock { id: string; code: string; name: string | null; dock_type: string; warehouse_id: string; }
interface Appointment {
  id: string;
  dock_id: string;
  appointment_type: "inbound" | "outbound";
  carrier_id: string | null;
  reference: string | null;
  window_start: string;
  window_end: string;
  state: "scheduled" | "arrived" | "in_progress" | "completed" | "cancelled" | "no_show";
  cancelled_reason: string | null;
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function fmt(t: string) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const STATE_TONE: Record<Appointment["state"], string> = {
  scheduled: "bg-muted text-muted-foreground",
  arrived: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-destructive/15 text-destructive",
  no_show: "bg-destructive/15 text-destructive",
};

export default function DockSchedule() {
  const qc = useQueryClient();
  const [warehouseId, setWarehouseId] = useState("");
  const [day, setDay] = useState(todayISO());

  const { data: warehouses } = useQuery({
    queryKey: ["dock-schedule-warehouses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouses")
        .select("id, name, business_id")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Warehouse[];
    },
  });

  const { data: docks } = useQuery({
    queryKey: ["dock-schedule-docks", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouse_docks")
        .select("id, code, name, dock_type, warehouse_id")
        .eq("warehouse_id", warehouseId)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return (data ?? []) as Dock[];
    },
  });

  const dayStart = useMemo(() => new Date(`${day}T00:00:00`).toISOString(), [day]);
  const dayEnd = useMemo(() => new Date(`${day}T23:59:59.999`).toISOString(), [day]);

  const { data: appointments, isLoading } = useQuery({
    queryKey: ["dock-schedule-appts", warehouseId, day],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_dock_appointments")
        .select("id, dock_id, appointment_type, carrier_id, reference, window_start, window_end, state, cancelled_reason")
        .eq("warehouse_id", warehouseId)
        .gte("window_start", dayStart)
        .lte("window_start", dayEnd)
        .order("window_start");
      if (error) throw error;
      return (data ?? []) as Appointment[];
    },
  });

  const transition = useMutation({
    mutationFn: async ({ id, rpc, reason }: { id: string; rpc: string; reason?: string }) => {
      const args: Record<string, unknown> = { p_appointment_id: id };
      if (rpc === "cancel_dock_appointment") args.p_reason = reason ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase.rpc(rpc as any, args as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["dock-schedule-appts"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const byDock = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const a of appointments ?? []) {
      const list = map.get(a.dock_id) ?? [];
      list.push(a);
      map.set(a.dock_id, list);
    }
    return map;
  }, [appointments]);

  return (
    <>
      <PageHeader
        title="Dock schedule"
        description="Inbound & outbound appointments per dock. Prevents truck collisions on the same door."
        actions={
          <Button asChild disabled={!warehouseId}>
            <Link to={`/warehouse-app/schedule/new${warehouseId ? `?warehouse=${warehouseId}` : ""}`}>
              <Plus className="h-4 w-4 mr-2" /> Schedule appointment
            </Link>
          </Button>
        }
      />
      <PageBody>
        <Section>
          <Card>
            <CardContent className="p-4 flex flex-wrap gap-4 items-end">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Warehouse</label>
                <select
                  className="border rounded px-2 py-1 bg-background"
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {(warehouses ?? []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Date</label>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-auto" />
              </div>
            </CardContent>
          </Card>
        </Section>

        {!warehouseId ? (
          <Section>
            <Card><CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Pick a warehouse to view its dock schedule.
            </CardContent></Card>
          </Section>
        ) : isLoading ? (
          <LoadingState />
        ) : (docks ?? []).length === 0 ? (
          <Section>
            <Card><CardContent className="p-6 text-sm text-muted-foreground">
              No docks configured for this warehouse yet. Add one from the dispatch flow.
            </CardContent></Card>
          </Section>
        ) : (
          <Section title={`Docks — ${day}`}>
            <div className="grid gap-3">
              {(docks ?? []).map((d) => {
                const list = byDock.get(d.id) ?? [];
                return (
                  <Card key={d.id}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="font-medium">{d.code} <span className="text-muted-foreground">— {d.name ?? d.dock_type}</span></div>
                        <div className="text-xs text-muted-foreground">{list.length} appointment{list.length === 1 ? "" : "s"}</div>
                      </div>
                      {list.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No appointments.</div>
                      ) : (
                        <div className="space-y-2">
                          {list.map((a) => (
                            <div key={a.id} className="flex flex-wrap items-center gap-2 border rounded p-2">
                              <Badge variant="outline">{a.appointment_type}</Badge>
                              <div className="font-mono text-xs">
                                {fmt(a.window_start)} – {fmt(a.window_end)}
                              </div>
                              {a.reference && <div className="text-xs text-muted-foreground">{a.reference}</div>}
                              <span className={`text-xs px-2 py-0.5 rounded ${STATE_TONE[a.state]}`}>{a.state}</span>
                              <div className="ml-auto flex gap-1">
                                {a.state === "scheduled" && (
                                  <Button size="sm" variant="outline"
                                    onClick={() => transition.mutate({ id: a.id, rpc: "mark_appointment_arrived" })}>
                                    Arrived
                                  </Button>
                                )}
                                {(a.state === "arrived" || a.state === "scheduled") && (
                                  <Button size="sm" variant="outline"
                                    onClick={() => transition.mutate({ id: a.id, rpc: "start_appointment" })}>
                                    Start
                                  </Button>
                                )}
                                {(a.state === "arrived" || a.state === "in_progress") && (
                                  <Button size="sm"
                                    onClick={() => transition.mutate({ id: a.id, rpc: "complete_dock_appointment" })}>
                                    Complete
                                  </Button>
                                )}
                                {a.state !== "completed" && a.state !== "cancelled" && a.state !== "no_show" && (
                                  <Button size="sm" variant="ghost"
                                    onClick={() => {
                                      const reason = window.prompt("Cancellation reason (optional)") ?? undefined;
                                      transition.mutate({ id: a.id, rpc: "cancel_dock_appointment", reason });
                                    }}>
                                    Cancel
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </Section>
        )}
      </PageBody>
    </>
  );
}