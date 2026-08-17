/**
 * LoadingManifestPlanner — opens a new `wms_loading_manifest` via
 * `open_loading_manifest`. Never inserts directly.
 *
 * Docks are user-managed in `warehouse_docks`; a minimal inline creator
 * is provided here so operators can bootstrap docks without leaving the
 * flow (Phase 5 has no dedicated dock master screen yet).
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { wmsErrorToast } from "@/features/warehouse/errors/wmsRpcError";
import { PageHeader, PageBody, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Truck } from "lucide-react";

interface Warehouse { id: string; name: string; business_id: string; organization_id: string; branch_id: string | null; }
interface Dock { id: string; code: string; name: string | null; dock_type: string; warehouse_id: string; }
interface Carrier { id: string; name: string; }
interface Appointment { id: string; reference: string | null; window_start: string; window_end: string; state: string; carrier_id: string | null; }

export default function LoadingManifestPlanner() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [warehouseId, setWarehouseId] = useState("");
  const [dockId, setDockId] = useState("");
  const [carrierId, setCarrierId] = useState("");
  const [plannedAt, setPlannedAt] = useState("");
  const [newDockCode, setNewDockCode] = useState("");
  const [appointmentId, setAppointmentId] = useState("");

  const { data: warehouses } = useQuery({
    queryKey: ["warehouses-for-manifest"],
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouses")
        .select("id, name, business_id, organization_id, branch_id").order("name");
      if (error) throw error;
      return (data ?? []) as Warehouse[];
    },
  });

  const { data: docks } = useQuery({
    queryKey: ["docks-for-manifest", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouse_docks")
        .select("id, code, name, dock_type, warehouse_id")
        .eq("warehouse_id", warehouseId).eq("is_active", true).order("code");
      if (error) throw error;
      return (data ?? []) as Dock[];
    },
  });

  const { data: carriers } = useQuery({
    queryKey: ["carriers-for-manifest"],
    queryFn: async () => {
      const { data, error } = await supabase.from("carriers")
        .select("id, name").eq("is_active", true).order("name");
      if (error) return [] as Carrier[];
      return (data ?? []) as Carrier[];
    },
  });

  const { data: appointments } = useQuery({
    queryKey: ["appointments-for-manifest", dockId],
    enabled: !!dockId,
    queryFn: async () => {
      const { data, error } = await supabase.from("wms_dock_appointments")
        .select("id, reference, window_start, window_end, state, carrier_id")
        .eq("dock_id", dockId)
        .eq("appointment_type", "outbound")
        .in("state", ["scheduled", "arrived"])
        .order("window_start");
      if (error) return [] as Appointment[];
      return (data ?? []) as Appointment[];
    },
  });

  const createDock = useMutation({
    mutationFn: async () => {
      const wh = warehouses?.find((w) => w.id === warehouseId);
      if (!wh) throw new Error("Pick a warehouse first");
      if (!newDockCode.trim()) throw new Error("Dock code required");
      const { data, error } = await supabase.from("warehouse_docks").insert({
        organization_id: wh.organization_id,
        business_id: wh.business_id,
        warehouse_id: wh.id,
        code: newDockCode.trim(),
        dock_type: "shipping",
        is_active: true,
      }).select("id").single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success("Dock created");
      setNewDockCode("");
      setDockId(id);
      qc.invalidateQueries({ queryKey: ["docks-for-manifest", warehouseId] });
    },
    onError: (e: unknown) => toast.error(...wmsErrorToast(e, "Action failed")),
  });

  const openManifest = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("open_loading_manifest", {
        p_dock_id: dockId,
        p_carrier_id: carrierId || null,
        p_planned_departure_at: plannedAt ? new Date(plannedAt).toISOString() : null,
        // Always send the argument: the legacy 3-arg overload was removed in
        // Phase A, so omitting it would leave no matching function signature.
        p_appointment_id: appointmentId || null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (id) => {
      toast.success("Manifest opened");
      nav(`/warehouse-app/dispatch/${id}`);
    },
    onError: (e: unknown) => toast.error(...wmsErrorToast(e, "Action failed")),
  });

  return (
    <>
      <PageHeader
        title="Open loading manifest"
        actions={<Button variant="outline" asChild><Link to="/warehouse-app/dispatch"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link></Button>}
      />
      <PageBody>
        <Section title="Manifest">
          <div className="space-y-4">
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
              <div className="flex gap-2">
                <select className="border rounded px-2 py-1 flex-1 bg-background" value={dockId} onChange={(e) => setDockId(e.target.value)}>
                  <option value="">Select…</option>
                  {(docks ?? []).map((d) => <option key={d.id} value={d.id}>{d.code} — {d.name ?? d.dock_type}</option>)}
                </select>
              </div>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Or add dock code (e.g. D-01)" value={newDockCode} onChange={(e) => setNewDockCode(e.target.value)} />
                <Button variant="outline" onClick={() => createDock.mutate()} disabled={createDock.isPending}>Add dock</Button>
              </div>
            </div>
          )}
          <div>
            <Label>Carrier (optional)</Label>
            <select className="border rounded px-2 py-1 bg-background" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
              <option value="">None</option>
              {(carriers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {dockId && (
            <div>
              <Label>Dock appointment (optional)</Label>
              <select className="border rounded px-2 py-1 bg-background w-full" value={appointmentId} onChange={(e) => {
                const id = e.target.value;
                setAppointmentId(id);
                const appt = (appointments ?? []).find((a) => a.id === id);
                if (appt) {
                  if (appt.carrier_id) setCarrierId(appt.carrier_id);
                  if (!plannedAt) {
                    const d = new Date(appt.window_end);
                    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                    setPlannedAt(local);
                  }
                }
              }}>
                <option value="">None</option>
                {(appointments ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {new Date(a.window_start).toLocaleString()} – {new Date(a.window_end).toLocaleTimeString()} · {a.reference ?? a.state}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                <Link to="/warehouse-app/schedule/new" className="underline">Schedule an appointment</Link> for this dock.
              </p>
            </div>
          )}
          <div>
            <Label>Planned departure</Label>
            <Input type="datetime-local" value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)} />
          </div>
          <Button disabled={!dockId || openManifest.isPending} onClick={() => openManifest.mutate()}>
            <Truck className="h-4 w-4 mr-2" /> Open manifest
          </Button>
          </div>
        </Section>
      </PageBody>
    </>
  );
}
