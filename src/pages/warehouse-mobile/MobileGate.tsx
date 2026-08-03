/**
 * MobileGate — handheld gatehouse console (Phase F).
 *
 * The guard scans the driver's appointment QR (or keys the appointment
 * number), verifies identity and seal, and admits the trailer. Every write
 * is a `gate_*` RPC; the screen holds no authority of its own.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, LogOut, Search, Truck } from "lucide-react";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import {
  findAppointmentByToken,
  useGateApprove,
  useGateCheckIn,
  useGateExit,
  useLiveVisits,
} from "@/features/warehouse/dock/useDockScheduling";
import { hhmm, type AppointmentRow } from "@/features/warehouse/dock/dockScheduling";

export default function MobileGate() {
  const [warehouseId, setWarehouseId] = useState("");
  const [code, setCode] = useState("");
  const [appt, setAppt] = useState<AppointmentRow | null>(null);
  const [trailerRef, setTrailerRef] = useState("");
  const [driverName, setDriverName] = useState("");
  const [identityRef, setIdentityRef] = useState("");
  const [sealIn, setSealIn] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: warehouses } = useQuery({
    queryKey: ["gate-warehouses"],
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouses").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const effectiveWarehouse = warehouseId || (warehouses?.length === 1 ? warehouses[0].id : "");
  const { data: visits } = useLiveVisits(effectiveWarehouse);

  const checkIn = useGateCheckIn();
  const approve = useGateApprove();
  const exit = useGateExit();

  async function lookup(raw: string) {
    const token = raw.trim();
    if (!token) return;
    setBusy(true);
    try {
      const found = await findAppointmentByToken(token);
      if (!found) {
        toast.error("No appointment matches that pass — check in as a walk-in");
        setAppt(null);
      } else {
        setAppt(found);
        setTrailerRef(found.trailer_ref ?? "");
        setDriverName(found.driver_name ?? "");
        if (!warehouseId) setWarehouseId(found.warehouse_id);
        toast.success(`Found ${found.appointment_no ?? "appointment"}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  // Handheld scanners deliver the gate pass through the WMS scan router.
  useWmsScanIntent({
    intent: "gate.pass",
    onScan: (payload) => {
      setCode(payload.resolveCode);
      void lookup(payload.resolveCode);
    },
  });

  const canCheckIn = !!effectiveWarehouse && !!trailerRef.trim() && !checkIn.isPending;

  const pending = useMemo(
    () => (visits ?? []).filter((v) => v.status === "arrived" || v.status === "in_yard"),
    [visits],
  );

  return (
    <MobileWarehouseLayout title="Gatehouse" back="/wm" scanLabel="Scan gate pass">
      <div className="space-y-4">
        <div>
          <Label>Warehouse</Label>
          <select
            className="border rounded px-2 py-2 w-full bg-background"
            value={effectiveWarehouse}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">Select…</option>
            {(warehouses ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>

        <div>
          <Label>Gate pass or appointment number</Label>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lookup(code)}
              placeholder="APT-000123"
            />
            <Button variant="outline" onClick={() => lookup(code)} disabled={busy}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {appt && (
          <div className="rounded border p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{appt.appointment_type}</Badge>
              <span className="font-mono">{appt.appointment_no}</span>
            </div>
            <div className="text-muted-foreground">
              Window {hhmm(appt.window_start)}–{hhmm(appt.window_end)}
            </div>
            {appt.reference && <div className="text-muted-foreground">Ref {appt.reference}</div>}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Trailer</Label>
            <Input value={trailerRef} onChange={(e) => setTrailerRef(e.target.value)} />
          </div>
          <div>
            <Label>Driver</Label>
            <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
          </div>
          <div>
            <Label>Driver ID</Label>
            <Input value={identityRef} onChange={(e) => setIdentityRef(e.target.value)} placeholder="Licence no." />
          </div>
          <div>
            <Label>Seal in</Label>
            <Input value={sealIn} onChange={(e) => setSealIn(e.target.value)} />
          </div>
        </div>

        <Button
          className="w-full h-12"
          disabled={!canCheckIn}
          onClick={() => {
            checkIn.mutate(
              {
                warehouseId: effectiveWarehouse,
                trailerRef: trailerRef.trim(),
                qrToken: appt?.qr_token ?? null,
                appointmentId: appt?.id ?? null,
                driverName: driverName || null,
                sealIn: sealIn || null,
                identityKind: identityRef ? "drivers_licence" : null,
                identityRef: identityRef || null,
              },
              {
                onSuccess: () => {
                  setCode("");
                  setAppt(null);
                  setTrailerRef("");
                  setDriverName("");
                  setIdentityRef("");
                  setSealIn("");
                },
              },
            );
          }}
        >
          <ShieldCheck className="h-4 w-4 mr-2" />
          {appt ? "Admit against appointment" : "Admit as walk-in"}
        </Button>

        <div>
          <div className="text-sm font-medium mb-2">On site</div>
          {pending.length === 0 ? (
            <div className="text-sm text-muted-foreground">No trailers waiting.</div>
          ) : (
            <ul className="space-y-2">
              {pending.map((v) => (
                <li key={v.id} className="rounded border p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Truck className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{v.trailer_ref}</span>
                    <Badge variant="outline">{v.status.replace(/_/g, " ")}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{hhmm(v.arrived_at)}</span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline"
                      onClick={() => approve.mutate({ visitId: v.id, approved: true })}>
                      Verify
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => approve.mutate({ visitId: v.id, approved: false })}>
                      Reject
                    </Button>
                    <Button size="sm" variant="secondary" className="ml-auto"
                      onClick={() => {
                        const seal = window.prompt("Seal out (optional)") ?? undefined;
                        exit.mutate({ visitId: v.id, sealOut: seal });
                      }}>
                      <LogOut className="h-4 w-4 mr-1" /> Release
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </MobileWarehouseLayout>
  );
}
