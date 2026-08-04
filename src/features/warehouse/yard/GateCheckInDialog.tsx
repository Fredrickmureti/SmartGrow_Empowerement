/**
 * GateCheckInDialog — the arrival capture form used by both the control
 * tower and the mobile gate console.
 *
 * Always calls `gate_check_in`, never `check_in_trailer`, so identity and
 * seal capture land in `wms_gate_events` as part of the same transaction.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useGateCheckIn, useYardCarriers, useExpectedAppointments } from "./useYard";
import type { VisitRow } from "./yardModel";

const NONE = "__none__";

export function GateCheckInDialog({
  open,
  onOpenChange,
  warehouseId,
  onCheckedIn,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string;
  onCheckedIn?: (v: VisitRow) => void;
}) {
  const [trailerRef, setTrailerRef] = useState("");
  const [carrierId, setCarrierId] = useState(NONE);
  const [appointmentId, setAppointmentId] = useState(NONE);
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [identityRef, setIdentityRef] = useState("");
  const [sealIn, setSealIn] = useState("");

  const carriers = useYardCarriers();
  const appointments = useExpectedAppointments(warehouseId || null);
  const checkIn = useGateCheckIn((v) => {
    onOpenChange(false);
    onCheckedIn?.(v);
  });

  useEffect(() => {
    if (!open) {
      setTrailerRef("");
      setCarrierId(NONE);
      setAppointmentId(NONE);
      setDriverName("");
      setDriverPhone("");
      setIdentityRef("");
      setSealIn("");
    }
  }, [open]);

  // Selecting an appointment pre-fills what the planner already knows.
  function pickAppointment(id: string) {
    setAppointmentId(id);
    const appt = (appointments.data ?? []).find((a) => a.id === id);
    if (!appt) return;
    if (appt.trailer_ref && !trailerRef) setTrailerRef(appt.trailer_ref);
    if (appt.driver_name && !driverName) setDriverName(appt.driver_name);
    if (appt.driver_phone && !driverPhone) setDriverPhone(appt.driver_phone);
    if (appt.carrier_id) setCarrierId(appt.carrier_id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Gate check-in</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Expected appointment</Label>
            <Select value={appointmentId} onValueChange={pickAppointment}>
              <SelectTrigger>
                <SelectValue placeholder="Walk-in (no appointment)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Walk-in (no appointment)</SelectItem>
                {(appointments.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.appointment_no ?? a.appointment_type} · {new Date(a.window_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {a.trailer_ref ? ` · ${a.trailer_ref}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Trailer / vehicle reference *</Label>
            <Input
              autoFocus
              value={trailerRef}
              onChange={(e) => setTrailerRef(e.target.value.toUpperCase())}
              placeholder="TRL-4471"
            />
          </div>

          <div className="min-w-0 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Carrier</Label>
              <Select value={carrierId} onValueChange={setCarrierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Unknown" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unknown</SelectItem>
                  {(carriers.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Inbound seal</Label>
              <Input value={sealIn} onChange={(e) => setSealIn(e.target.value)} placeholder="Seal no." />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Driver name</Label>
              <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Driver phone</Label>
              <Input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Driver ID reference</Label>
            <Input
              value={identityRef}
              onChange={(e) => setIdentityRef(e.target.value)}
              placeholder="Licence / national ID recorded at the gate"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!trailerRef.trim() || !warehouseId || checkIn.isPending}
            onClick={() =>
              checkIn.mutate({
                warehouseId,
                trailerRef: trailerRef.trim(),
                appointmentId: appointmentId === NONE ? null : appointmentId,
                carrierId: carrierId === NONE ? null : carrierId,
                driverName: driverName.trim() || null,
                driverPhone: driverPhone.trim() || null,
                sealIn: sealIn.trim() || null,
                identityKind: identityRef.trim() ? "id_document" : null,
                identityRef: identityRef.trim() || null,
              })
            }
          >
            Check in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
