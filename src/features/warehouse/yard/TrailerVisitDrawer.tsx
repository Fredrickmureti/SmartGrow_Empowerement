/**
 * TrailerVisitDrawer — the single record surface for a yard visit.
 *
 * Everything a gate officer, yard jockey or supervisor can do to a
 * trailer lives here, gated on the visit's state machine, plus the two
 * audit trails that make the yard defensible: the gate chain of custody
 * (`wms_gate_events`) and the physical movement ledger (`wms_yard_moves`).
 */
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  DoorOpen,
  LogOut,
  Printer,
  ShieldCheck,
  Timer,
  XCircle,
} from "lucide-react";
import { format } from "date-fns";
import {
  blockerLabel,
  dwellMinutes,
  formatDwell,
  gateEventLabel,
  VISIT_STATUS_LABEL,
  YARD_MOVE_LABEL,
  type VisitRow,
  type YardSlotRow,
} from "./yardModel";
import {
  useApproveDeparture,
  useAssignTrailerToDock,
  useDepartureBlockers,
  useGateApprove,
  useGateExit,
  useMarkNoShow,
  useRelocateTrailer,
  useReleaseFromDock,
  useVisitGateEvents,
  useYardMoves,
} from "./useYard";

function ts(v: string | null | undefined) {
  return v ? format(new Date(v), "dd MMM HH:mm") : "—";
}

export function TrailerVisitDrawer({
  visit,
  slots,
  docks,
  onClose,
  onPrintPlacard,
}: {
  visit: VisitRow | null;
  slots: YardSlotRow[];
  docks: { id: string; code: string; name: string | null }[];
  onClose: () => void;
  onPrintPlacard?: (v: VisitRow) => void;
}) {
  const [slotId, setSlotId] = useState("");
  const [dockId, setDockId] = useState("");
  const [sealOut, setSealOut] = useState("");
  const [override, setOverride] = useState("");

  const gateEvents = useVisitGateEvents(visit?.id ?? null);
  const moves = useYardMoves(visit?.id ?? null);
  const blockers = useDepartureBlockers(
    visit && visit.status !== "departed" && visit.status !== "no_show" ? visit.id : null,
  );

  const approveGate = useGateApprove();
  const relocate = useRelocateTrailer();
  const assignDock = useAssignTrailerToDock();
  const release = useReleaseFromDock();
  const approveDeparture = useApproveDeparture();
  const exit = useGateExit();
  const noShow = useMarkNoShow();

  if (!visit) return null;

  const open = visit.status === "arrived" || visit.status === "in_yard" || visit.status === "at_dock";
  const blocking = (blockers.data ?? []) as ReturnType<typeof Array.prototype.slice> extends never ? never[] : NonNullable<typeof blockers.data>;
  const hasBlockers = (blocking?.length ?? 0) > 0;
  const freeSlots = slots.filter((s) => s.status !== "blocked" || s.id === visit.yard_slot_id);

  return (
    <Sheet open={!!visit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {visit.trailer_ref}
            <Badge variant="outline">{VISIT_STATUS_LABEL[visit.status]}</Badge>
            {visit.departure_approved_at && (
              <Badge className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/10">Cleared</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {visit.carrier?.name ?? "Walk-in"} · driver {visit.driver_name || "unknown"}
            {visit.driver_phone ? ` · ${visit.driver_phone}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Vitals ---------------------------------------------------- */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Arrived</p>
              <p>{ts(visit.arrived_at)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Timer className="h-3 w-3" /> Dwell
              </p>
              <p>{formatDwell(dwellMinutes(visit))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Yard position</p>
              <p>{visit.slot?.code ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Dock</p>
              <p>{visit.dock?.name || visit.dock?.code || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Seal in / out</p>
              <p>
                {visit.seal_in || "—"} / {visit.seal_out || "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Appointment</p>
              <p>
                {visit.appointment
                  ? `${visit.appointment.appointment_no ?? visit.appointment.appointment_type} · ${format(
                      new Date(visit.appointment.window_start),
                      "HH:mm",
                    )}–${format(new Date(visit.appointment.window_end), "HH:mm")}`
                  : "Walk-in"}
              </p>
            </div>
          </div>

          {onPrintPlacard && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onPrintPlacard(visit)}>
              <Printer className="h-3.5 w-3.5" /> Print yard placard
            </Button>
          )}

          <Separator />

          {/* Actions --------------------------------------------------- */}
          {open ? (
            <div className="space-y-4">
              {visit.status === "arrived" && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={approveGate.isPending}
                    onClick={() => approveGate.mutate({ visitId: visit.id, approved: true })}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" /> Security clear
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-destructive"
                    disabled={noShow.isPending}
                    onClick={() => noShow.mutate({ visitId: visit.id })}
                  >
                    <XCircle className="h-3.5 w-3.5" /> No-show
                  </Button>
                </div>
              )}

              {visit.status !== "at_dock" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Move to yard slot</Label>
                  <div className="flex gap-2">
                    <Select value={slotId} onValueChange={setSlotId}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Pick a slot" />
                      </SelectTrigger>
                      <SelectContent>
                        {freeSlots.map((s) => (
                          <SelectItem key={s.id} value={s.id} disabled={s.status === "occupied" && s.id !== visit.yard_slot_id}>
                            {s.code} {s.status === "occupied" && s.id !== visit.yard_slot_id ? "(occupied)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={!slotId || relocate.isPending}
                      onClick={() => relocate.mutate({ visitId: visit.id, slotId }, { onSuccess: () => setSlotId("") })}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" /> Move
                    </Button>
                  </div>
                </div>
              )}

              {visit.status !== "at_dock" ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Assign to dock</Label>
                  <div className="flex gap-2">
                    <Select value={dockId} onValueChange={setDockId}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Pick a dock" />
                      </SelectTrigger>
                      <SelectContent>
                        {docks.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name || d.code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={!dockId || assignDock.isPending}
                      onClick={() => assignDock.mutate({ visitId: visit.id, dockId }, { onSuccess: () => setDockId("") })}
                    >
                      <DoorOpen className="h-3.5 w-3.5" /> Dock
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={release.isPending}
                  onClick={() => release.mutate({ visitId: visit.id })}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Release from dock back to yard
                </Button>
              )}

              <Separator />

              {/* Departure gate ---------------------------------------- */}
              {hasBlockers && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Open work blocks departure</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5 text-xs">
                      {(blocking ?? []).map((b) => (
                        <li key={`${b.kind}:${b.id}`}>{blockerLabel(b)}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {!visit.departure_approved_at ? (
                <div className="space-y-1.5">
                  {hasBlockers && (
                    <>
                      <Label className="text-xs">Supervisor override reason (required to force clearance)</Label>
                      <Textarea
                        rows={2}
                        value={override}
                        onChange={(e) => setOverride(e.target.value)}
                        placeholder="Why is this trailer allowed to leave with open work?"
                      />
                    </>
                  )}
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={approveDeparture.isPending || (hasBlockers && override.trim().length < 5)}
                    onClick={() =>
                      approveDeparture.mutate({
                        visitId: visit.id,
                        overrideReason: hasBlockers ? override.trim() : null,
                      })
                    }
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Clear for departure
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Cleared {ts(visit.departure_approved_at)}
                    {visit.departure_override_reason ? ` · override: ${visit.departure_override_reason}` : ""}
                  </p>
                  <Label className="text-xs">Exit seal</Label>
                  <div className="flex gap-2">
                    <Input
                      className="h-9"
                      value={sealOut}
                      onChange={(e) => setSealOut(e.target.value)}
                      placeholder="Seal number (optional)"
                    />
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={exit.isPending}
                      onClick={() => exit.mutate({ visitId: visit.id, sealOut: sealOut.trim() || null })}
                    >
                      <LogOut className="h-3.5 w-3.5" /> Gate exit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Visit closed {ts(visit.departed_at)} · dwell {formatDwell(dwellMinutes(visit))}.
            </p>
          )}

          <Separator />

          {/* Audit ------------------------------------------------------ */}
          <Tabs defaultValue="moves">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="moves">Movement ledger</TabsTrigger>
              <TabsTrigger value="gate">Gate custody</TabsTrigger>
            </TabsList>
            <TabsContent value="moves" className="pt-3">
              {(moves.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No physical moves recorded.</p>
              ) : (
                <ol className="space-y-2">
                  {(moves.data ?? []).map((m) => (
                    <li key={m.id} className="text-xs flex gap-2">
                      <span className="text-muted-foreground w-24 shrink-0">{ts(m.occurred_at)}</span>
                      <span className="flex-1">
                        <span className="font-medium">{YARD_MOVE_LABEL[m.reason] ?? m.reason}</span>
                        {(m.from_slot?.code || m.from_dock?.code || m.to_slot?.code || m.to_dock?.code) && (
                          <span className="text-muted-foreground">
                            {" "}
                            {m.from_slot?.code || m.from_dock?.code || "gate"} →{" "}
                            {m.to_slot?.code || m.to_dock?.code || "gate"}
                          </span>
                        )}
                        {m.notes && <span className="text-muted-foreground"> · {m.notes}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
            <TabsContent value="gate" className="pt-3">
              {(gateEvents.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No gate events recorded.</p>
              ) : (
                <ol className="space-y-2">
                  {(gateEvents.data ?? []).map((g) => (
                    <li key={g.id} className="text-xs flex gap-2">
                      <span className="text-muted-foreground w-24 shrink-0">{ts(g.occurred_at)}</span>
                      <span className="flex-1">
                        <span className="font-medium">{gateEventLabel(g.event_type)}</span>
                        {g.identity_ref && <span className="text-muted-foreground"> · {g.identity_ref}</span>}
                        {g.seal_ref && <span className="text-muted-foreground"> · seal {g.seal_ref}</span>}
                        {g.notes && <span className="text-muted-foreground"> · {g.notes}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
