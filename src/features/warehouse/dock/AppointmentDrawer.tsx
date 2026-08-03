/**
 * AppointmentDrawer — progressive disclosure for one dock appointment.
 * Primary board stays humanised; ids, QR gate pass, linked documents and
 * the gate/yard timeline live here.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router-dom";
import {
  APPOINTMENT_STATE_LABEL,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  docTypeLabel,
  gateEventLabel,
  hhmm,
  type AppointmentRow,
  type DockRow,
} from "./dockScheduling";
import {
  useAppointmentDocuments,
  useAppointmentTransition,
  useGateEvents,
} from "./useDockScheduling";

interface Props {
  appointment: AppointmentRow | null;
  dock?: DockRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm truncate">{value ?? "—"}</div>
    </div>
  );
}

export function AppointmentDrawer({ appointment, dock, open, onOpenChange }: Props) {
  const transition = useAppointmentTransition();
  const { data: docs } = useAppointmentDocuments(appointment?.id ?? null);
  const { data: events } = useGateEvents(appointment?.id ?? null);

  if (!appointment) return null;
  const a = appointment;
  const active = a.state !== "completed" && a.state !== "cancelled" && a.state !== "no_show";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {a.appointment_no ?? "Appointment"}
            <Badge variant="outline">{a.appointment_type === "inbound" ? "Inbound" : "Outbound"}</Badge>
            <Badge variant="secondary">{APPOINTMENT_STATE_LABEL[a.state]}</Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="Dock" value={dock ? `${dock.code} — ${dock.name ?? dock.dock_type}` : "—"} />
          <Field
            label="Priority"
            value={
              <span className={PRIORITY_TONE[(a.priority ?? "normal") as keyof typeof PRIORITY_TONE]}>
                {PRIORITY_LABEL[(a.priority ?? "normal") as keyof typeof PRIORITY_LABEL]}
              </span>
            }
          />
          <Field label="Window" value={`${hhmm(a.window_start)} – ${hhmm(a.window_end)}`} />
          <Field label="Planned departure" value={hhmm(a.scheduled_departure)} />
          <Field label="Reference" value={a.reference} />
          <Field label="Trailer / tractor" value={[a.trailer_ref, a.tractor_ref].filter(Boolean).join(" / ") || "—"} />
          <Field label="Driver" value={a.driver_name} />
          <Field label="Driver phone" value={a.driver_phone} />
          <Field label="Arrived" value={hhmm(a.arrived_at)} />
          <Field label="Completed" value={hhmm(a.completed_at)} />
        </div>

        {active && (
          <>
            <Separator className="my-4" />
            <div className="flex flex-wrap gap-2">
              {a.state === "scheduled" && (
                <Button size="sm" variant="outline"
                  onClick={() => transition.mutate({ id: a.id, rpc: "mark_appointment_arrived" })}>
                  Mark arrived
                </Button>
              )}
              {(a.state === "scheduled" || a.state === "arrived") && (
                <Button size="sm" variant="outline"
                  onClick={() => transition.mutate({ id: a.id, rpc: "start_appointment" })}>
                  Start at dock
                </Button>
              )}
              {(a.state === "arrived" || a.state === "in_progress") && (
                <Button size="sm"
                  onClick={() => transition.mutate({ id: a.id, rpc: "complete_dock_appointment" })}>
                  Complete
                </Button>
              )}
              <Button size="sm" variant="ghost"
                onClick={() => {
                  const reason = window.prompt("Cancellation reason (optional)") ?? undefined;
                  transition.mutate({ id: a.id, rpc: "cancel_dock_appointment", reason });
                }}>
                Cancel
              </Button>
            </div>
          </>
        )}

        <Separator className="my-4" />
        <div className="text-sm font-medium mb-2">Linked documents</div>
        {(docs ?? []).length === 0 ? (
          <div className="text-sm text-muted-foreground">No documents linked to this appointment.</div>
        ) : (
          <ul className="space-y-1">
            {(docs ?? []).map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <Badge variant="outline">{docTypeLabel(d.doc_type)}</Badge>
                <span className="font-mono text-xs">{d.doc_number ?? d.doc_id?.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}

        <Separator className="my-4" />
        <div className="text-sm font-medium mb-2">Gate pass</div>
        {a.qr_token ? (
          <div className="flex items-center gap-4">
            <div className="bg-white p-2 rounded">
              <QRCodeSVG value={`APT:${a.qr_token}`} size={112} />
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>Driver scans this at the gate, or the guard keys in the appointment number.</div>
              <div className="font-mono">{a.appointment_no}</div>
              <Button asChild size="sm" variant="outline">
                <Link to="/wm/gate">Open gate console</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No gate pass issued.</div>
        )}

        <Separator className="my-4" />
        <div className="text-sm font-medium mb-2">Gate timeline</div>
        {(events ?? []).length === 0 ? (
          <div className="text-sm text-muted-foreground">No gate activity yet.</div>
        ) : (
          <ol className="space-y-2">
            {(events ?? []).map((e) => (
              <li key={e.id} className="text-sm flex items-start gap-2">
                <span className="font-mono text-xs text-muted-foreground w-12 shrink-0">
                  {hhmm(e.occurred_at)}
                </span>
                <span>
                  {gateEventLabel(e.event_type)}
                  {e.identity_ref ? ` · ${e.identity_kind ?? "ID"} ${e.identity_ref}` : ""}
                  {e.seal_ref ? ` · seal ${e.seal_ref}` : ""}
                  {e.notes ? ` — ${e.notes}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}

        <Separator className="my-4" />
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Support engineer view</summary>
          <div className="mt-2 font-mono break-all space-y-1">
            <div>appointment_id: {a.id}</div>
            <div>dock_id: {a.dock_id}</div>
            <div>qr_token: {a.qr_token ?? "—"}</div>
          </div>
        </details>
      </SheetContent>
    </Sheet>
  );
}

export default AppointmentDrawer;
