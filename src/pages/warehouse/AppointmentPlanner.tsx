/**
 * AppointmentPlanner — creates a new `wms_dock_appointment` via
 * `schedule_dock_appointment`. Never inserts directly.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CalendarClock } from "lucide-react";

interface Warehouse { id: string; name: string; }
interface Dock { id: string; code: string; name: string | null; dock_type: string; }
interface Carrier { id: string; name: string; }

export default function AppointmentPlanner() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [warehouseId, setWarehouseId] = useState(params.get("warehouse") ?? "");
  const [dockId, setDockId] = useState("");
  const [appointmentType, setAppointmentType] = useState<"inbound" | "outbound">("inbound");
  const [carrierId, setCarrierId] = useState("");
  const [reference, setReference] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");

  const { data: warehouses } = useQuery({
    queryKey: ["appt-warehouses"],
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouses").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as Warehouse[];
    },
  });

  const { data: docks } = useQuery({
    queryKey: ["appt-docks", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouse_docks")
        .select("id, code, name, dock_type")
        .eq("warehouse_id", warehouseId).eq("is_active", true).order("code");
      if (error) throw error;
      return (data ?? []) as Dock[];
    },
  });

  const { data: carriers } = useQuery({
    queryKey: ["appt-carriers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("carriers").select("id, name").eq("is_active", true).order("name");
      if (error) return [] as Carrier[];
      return (data ?? []) as Carrier[];
    },
  });

  const invalidRange = useMemo(() => {
    if (!windowStart || !windowEnd) return false;
    return new Date(windowEnd).getTime() <= new Date(windowStart).getTime();
  }, [windowStart, windowEnd]);

  const schedule = useMutation({
    mutationFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc("schedule_dock_appointment" as any, {
        p_dock_id: dockId,
        p_appointment_type: appointmentType,
        p_window_start: new Date(windowStart).toISOString(),
        p_window_end: new Date(windowEnd).toISOString(),
        p_carrier_id: carrierId || null,
        p_reference: reference || null,
      } as any);
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success("Appointment scheduled");
      nav(`/warehouse-app/schedule${warehouseId ? `?warehouse=${warehouseId}` : ""}`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const canSubmit = !!dockId && !!windowStart && !!windowEnd && !invalidRange && !schedule.isPending;

  return (
    <>
      <PageHeader
        title="Schedule dock appointment"
        actions={
          <Button variant="outline" asChild>
            <Link to="/warehouse-app/schedule"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Appointment">
          <Card>
            <CardContent className="p-4 space-y-4 max-w-xl">
              <div>
                <Label>Warehouse</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={warehouseId}
                  onChange={(e) => { setWarehouseId(e.target.value); setDockId(""); }}>
                  <option value="">Select…</option>
                  {(warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              {warehouseId && (
                <div>
                  <Label>Dock</Label>
                  <select className="border rounded px-2 py-1 w-full bg-background" value={dockId}
                    onChange={(e) => setDockId(e.target.value)}>
                    <option value="">Select…</option>
                    {(docks ?? []).map((d) => (
                      <option key={d.id} value={d.id}>{d.code} — {d.name ?? d.dock_type}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <Label>Type</Label>
                <select className="border rounded px-2 py-1 w-full bg-background"
                  value={appointmentType}
                  onChange={(e) => setAppointmentType(e.target.value as "inbound" | "outbound")}>
                  <option value="inbound">Inbound (goods receipt)</option>
                  <option value="outbound">Outbound (loading manifest)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Window start</Label>
                  <Input type="datetime-local" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
                </div>
                <div>
                  <Label>Window end</Label>
                  <Input type="datetime-local" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
                </div>
              </div>
              {invalidRange && (
                <div className="text-xs text-destructive">Window end must be after window start.</div>
              )}
              <div>
                <Label>Carrier (optional)</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={carrierId}
                  onChange={(e) => setCarrierId(e.target.value)}>
                  <option value="">None</option>
                  {(carriers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Reference (PO, SO, trailer, driver…)</Label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
              </div>
              <Button disabled={!canSubmit} onClick={() => schedule.mutate()}>
                <CalendarClock className="h-4 w-4 mr-2" /> Schedule
              </Button>
            </CardContent>
          </Card>
        </Section>
      </PageBody>
    </>
  );
}