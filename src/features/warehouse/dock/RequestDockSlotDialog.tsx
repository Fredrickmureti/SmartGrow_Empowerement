/**
 * RequestDockSlotDialog — Phase G origination surface.
 *
 * Any source document (purchase order, ASN, sales order, delivery note,
 * loading manifest, return order) can request a dock slot without knowing
 * anything about WMS internals. The dialog resolves docks, probes
 * feasibility server-side and books through `schedule_dock_appointment`,
 * writing the document link atomically.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CalendarClock, CheckCircle2, XCircle } from "lucide-react";
import {
  REQUIREMENT_FLAGS,
  docTypeLabel,
  toLocalInput,
  type AppointmentType,
} from "./dockScheduling";
import {
  useDocks,
  useFeasibility,
  useScheduleAppointment,
  useWarehouses,
} from "./useDockScheduling";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Source document requesting the slot. */
  docType: string;
  docId?: string | null;
  docNumber?: string | null;
  /** Inbound for receipts/returns, outbound for shipments. */
  appointmentType: AppointmentType;
  warehouseId?: string | null;
  carrierId?: string | null;
  defaultDurationMinutes?: number;
  onScheduled?: (appointmentId: string) => void;
}

export function RequestDockSlotDialog({
  open,
  onOpenChange,
  docType,
  docId,
  docNumber,
  appointmentType,
  warehouseId: warehouseIdProp,
  carrierId,
  defaultDurationMinutes = 60,
  onScheduled,
}: Props) {
  const { data: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState(warehouseIdProp ?? "");
  const [dockId, setDockId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [requirements, setRequirements] = useState<Record<string, boolean>>({});
  const [trailerRef, setTrailerRef] = useState("");
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return toLocalInput(d);
  });
  const [durationMin, setDurationMin] = useState(defaultDurationMinutes);

  useEffect(() => {
    if (warehouseIdProp) setWarehouseId(warehouseIdProp);
  }, [warehouseIdProp]);

  const { data: docks } = useDocks(warehouseId);

  const windowStartIso = useMemo(() => (start ? new Date(start).toISOString() : ""), [start]);
  const windowEndIso = useMemo(
    () => (start ? new Date(new Date(start).getTime() + durationMin * 60000).toISOString() : ""),
    [start, durationMin],
  );

  const activeRequirements = useMemo(
    () => Object.fromEntries(Object.entries(requirements).filter(([, v]) => v)),
    [requirements],
  );

  const feasibility = useFeasibility({
    dockId,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    requirements: activeRequirements,
  });

  const schedule = useScheduleAppointment((id) => {
    onScheduled?.(id);
    onOpenChange(false);
  });

  const canSubmit =
    !!dockId && !!windowStartIso && !!windowEndIso && !schedule.isPending && feasibility.data?.feasible !== false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" /> Request dock slot
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            {docTypeLabel(docType)} {docNumber ? <span className="font-mono">{docNumber}</span> : null} ·{" "}
            {appointmentType === "inbound" ? "Inbound" : "Outbound"}
          </div>

          {!warehouseIdProp && (
            <div>
              <Label>Warehouse</Label>
              <select
                className="border rounded px-2 py-1 w-full bg-background"
                value={warehouseId}
                onChange={(e) => {
                  setWarehouseId(e.target.value);
                  setDockId("");
                }}
              >
                <option value="">Select…</option>
                {(warehouses ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <Label>Dock</Label>
            <select
              className="border rounded px-2 py-1 w-full bg-background"
              value={dockId}
              onChange={(e) => setDockId(e.target.value)}
              disabled={!warehouseId}
            >
              <option value="">Select…</option>
              {(docks ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.code} — {d.name ?? d.dock_type}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Window start</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <Label>Duration (minutes)</Label>
              <Input
                type="number"
                min={15}
                step={15}
                value={durationMin}
                onChange={(e) => setDurationMin(Math.max(15, Number(e.target.value) || 60))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Priority</Label>
              <select
                className="border rounded px-2 py-1 w-full bg-background"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <Label>Trailer (optional)</Label>
              <Input value={trailerRef} onChange={(e) => setTrailerRef(e.target.value)} placeholder="KDA 123A" />
            </div>
          </div>

          <div>
            <Label>Dock requirements</Label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {REQUIREMENT_FLAGS.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={!!requirements[f.key]}
                    onCheckedChange={(v) => setRequirements((r) => ({ ...r, [f.key]: !!v }))}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>

          {dockId && feasibility.data && (
            <div
              className={`text-sm flex items-start gap-2 rounded border p-2 ${
                feasibility.data.feasible
                  ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                  : "border-destructive/30 text-destructive"
              }`}
            >
              {feasibility.data.feasible ? (
                <CheckCircle2 className="h-4 w-4 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 mt-0.5" />
              )}
              <div>
                {feasibility.data.feasible
                  ? "Slot is available on this dock."
                  : feasibility.data.reasons.join(" · ")}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              schedule.mutate({
                dockId,
                type: appointmentType,
                windowStart: windowStartIso,
                windowEnd: windowEndIso,
                carrierId: carrierId ?? null,
                reference: docNumber ?? null,
                priority,
                trailerRef: trailerRef || null,
                requirements: activeRequirements,
                documents: [{ doc_type: docType, doc_id: docId ?? null, doc_number: docNumber ?? null }],
              })
            }
          >
            {schedule.isPending ? "Booking…" : "Book slot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RequestDockSlotDialog;
