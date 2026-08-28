/**
 * AppointmentPlanner — books a `wms_dock_appointment` through
 * `schedule_dock_appointment` (never a direct insert). Captures the
 * enterprise appointment payload: priority, party, trailer/tractor,
 * driver, planned departure, dock requirements and source documents.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, PageBody, Section, toneText, toneBorder } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle2, XCircle, Plus, Trash2 } from "lucide-react";
import {
  DOC_TYPE_LABEL,
  REQUIREMENT_FLAGS,
  docTypeLabel,
} from "@/features/warehouse/dock/dockScheduling";
import {
  useCarriers,
  useDocks,
  useFeasibility,
  useScheduleAppointment,
  useWarehouses,
} from "@/features/warehouse/dock/useDockScheduling";
import { cn } from "@/lib/utils";

interface DocLink {
  doc_type: string;
  doc_number: string;
}

export default function AppointmentPlanner() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [warehouseId, setWarehouseId] = useState(params.get("warehouse") ?? "");
  const [dockId, setDockId] = useState("");
  const [appointmentType, setAppointmentType] = useState<"inbound" | "outbound">("inbound");
  const [priority, setPriority] = useState("normal");
  const [carrierId, setCarrierId] = useState("");
  const [reference, setReference] = useState("");
  const [trailerRef, setTrailerRef] = useState("");
  const [tractorRef, setTractorRef] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [scheduledDeparture, setScheduledDeparture] = useState("");
  const [requirements, setRequirements] = useState<Record<string, boolean>>({});
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [docType, setDocType] = useState("purchase_order");
  const [docNumber, setDocNumber] = useState("");

  const { data: warehouses } = useWarehouses();
  const { data: docks } = useDocks(warehouseId);
  const { data: carriers } = useCarriers();

  const invalidRange = useMemo(() => {
    if (!windowStart || !windowEnd) return false;
    return new Date(windowEnd).getTime() <= new Date(windowStart).getTime();
  }, [windowStart, windowEnd]);

  const activeRequirements = useMemo(
    () => Object.fromEntries(Object.entries(requirements).filter(([, v]) => v)),
    [requirements],
  );

  const startIso = useMemo(
    () => (windowStart && !invalidRange ? new Date(windowStart).toISOString() : ""),
    [windowStart, invalidRange],
  );
  const endIso = useMemo(
    () => (windowEnd && !invalidRange ? new Date(windowEnd).toISOString() : ""),
    [windowEnd, invalidRange],
  );

  const feasibility = useFeasibility({
    dockId,
    windowStart: startIso,
    windowEnd: endIso,
    requirements: activeRequirements,
  });

  const schedule = useScheduleAppointment(() =>
    nav(`/warehouse-app/schedule${warehouseId ? `?warehouse=${warehouseId}` : ""}`),
  );

  const canSubmit =
    !!dockId && !!startIso && !!endIso && !invalidRange && !schedule.isPending && feasibility.data?.feasible !== false;

  return (
    <>
      <PageHeader
        title="Schedule dock appointment"
        description="Capacity is validated against dock capability, maintenance downtime and existing bookings before the slot is committed."
        actions={
          <Button variant="outline" asChild>
            <Link to="/warehouse-app/schedule"><ArrowLeft className="h-4 w-4 mr-2" /> Back</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Slot">
          <div className="space-y-4 max-w-2xl">
            <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2">
              <div>
                <Label>Warehouse</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={warehouseId}
                  onChange={(e) => { setWarehouseId(e.target.value); setDockId(""); }}>
                  <option value="">Select…</option>
                  {(warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Dock</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={dockId}
                  disabled={!warehouseId}
                  onChange={(e) => setDockId(e.target.value)}>
                  <option value="">Select…</option>
                  {(docks ?? []).map((d) => (
                    <option key={d.id} value={d.id}>{d.code} — {d.name ?? d.dock_type}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Type</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={appointmentType}
                  onChange={(e) => setAppointmentType(e.target.value as "inbound" | "outbound")}>
                  <option value="inbound">Inbound (receiving)</option>
                  <option value="outbound">Outbound (dispatch)</option>
                </select>
              </div>
              <div>
                <Label>Priority</Label>
                <select className="border rounded px-2 py-1 w-full bg-background" value={priority}
                  onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <Label>Window start</Label>
                <Input type="datetime-local" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
              </div>
              <div>
                <Label>Window end</Label>
                <Input type="datetime-local" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </div>
              <div>
                <Label>Planned departure (optional)</Label>
                <Input type="datetime-local" value={scheduledDeparture}
                  onChange={(e) => setScheduledDeparture(e.target.value)} />
              </div>
              <div>
                <Label>Reference</Label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO / SO number" />
              </div>
            </div>

            {invalidRange && (
              <div className="text-xs text-destructive">Window end must be after window start.</div>
            )}

            <div>
              <Label>Dock requirements</Label>
              <div className="min-w-0 mt-1 grid gap-2 @xl/page:grid-cols-2">
                {REQUIREMENT_FLAGS.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={!!requirements[f.key]}
                      onCheckedChange={(v) => setRequirements((r) => ({ ...r, [f.key]: !!v }))} />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>

            {dockId && startIso && endIso && feasibility.data && (
              <div className={`text-sm flex items-start gap-2 rounded border p-2 ${
                feasibility.data.feasible
                  ? cn(toneBorder("success"), toneText("success"))
                  : "border-destructive/30 text-destructive"
              }`}>
                {feasibility.data.feasible
                  ? <CheckCircle2 className="h-4 w-4 mt-0.5" />
                  : <XCircle className="h-4 w-4 mt-0.5" />}
                <div>
                  {feasibility.data.feasible
                    ? "Dock is free and meets every requirement for this window."
                    : feasibility.data.reasons.join(" · ")}
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="Carrier & vehicle">
          <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2 max-w-2xl">
            <div>
              <Label>Carrier (optional)</Label>
              <select className="border rounded px-2 py-1 w-full bg-background" value={carrierId}
                onChange={(e) => setCarrierId(e.target.value)}>
                <option value="">Not specified</option>
                {(carriers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Trailer</Label>
              <Input value={trailerRef} onChange={(e) => setTrailerRef(e.target.value)} placeholder="Trailer / plate" />
            </div>
            <div>
              <Label>Tractor</Label>
              <Input value={tractorRef} onChange={(e) => setTractorRef(e.target.value)} placeholder="Tractor unit" />
            </div>
            <div>
              <Label>Driver name</Label>
              <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
            </div>
            <div>
              <Label>Driver phone</Label>
              <Input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
            </div>
          </div>
        </Section>

        <Section title="Linked documents">
          <div className="space-y-3 max-w-2xl">
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <Label>Document type</Label>
                <select className="border rounded px-2 py-1 bg-background" value={docType}
                  onChange={(e) => setDocType(e.target.value)}>
                  {Object.keys(DOC_TYPE_LABEL).map((k) => (
                    <option key={k} value={k}>{DOC_TYPE_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Number</Label>
                <Input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="PO-000123" />
              </div>
              <Button type="button" variant="outline" disabled={!docNumber.trim()}
                onClick={() => {
                  setDocs((d) => [...d, { doc_type: docType, doc_number: docNumber.trim() }]);
                  setDocNumber("");
                }}>
                <Plus className="h-4 w-4 mr-1" /> Link
              </Button>
            </div>
            {docs.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No documents linked. Appointments booked from a purchase order, shipment or manifest carry
                their link automatically.
              </div>
            ) : (
              <ul className="space-y-1">
                {docs.map((d, i) => (
                  <li key={`${d.doc_type}-${d.doc_number}-${i}`} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{docTypeLabel(d.doc_type)}</Badge>
                    <span className="font-mono text-xs">{d.doc_number}</span>
                    <Button size="sm" variant="ghost" className="ml-auto h-7 w-7 p-0"
                      aria-label="Remove"
                      onClick={() => setDocs((list) => list.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>

        <Section>
          <div className="flex gap-2">
            <Button disabled={!canSubmit}
              onClick={() =>
                schedule.mutate({
                  dockId,
                  type: appointmentType,
                  windowStart: startIso,
                  windowEnd: endIso,
                  carrierId: carrierId || null,
                  reference: reference || null,
                  priority,
                  trailerRef: trailerRef || null,
                  tractorRef: tractorRef || null,
                  driverName: driverName || null,
                  driverPhone: driverPhone || null,
                  scheduledDeparture: scheduledDeparture ? new Date(scheduledDeparture).toISOString() : null,
                  requirements: activeRequirements,
                  documents: docs.map((d) => ({ doc_type: d.doc_type, doc_number: d.doc_number })),
                })
              }>
              {schedule.isPending ? "Booking…" : "Book appointment"}
            </Button>
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/schedule">Cancel</Link>
            </Button>
          </div>
        </Section>
      </PageBody>
    </>
  );
}
