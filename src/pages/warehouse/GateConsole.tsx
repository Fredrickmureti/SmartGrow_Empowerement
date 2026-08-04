/**
 * Gate Console — the mobile-first surface for the guard house.
 *
 * Large touch targets, one job per row: check in what's expected, clear
 * or reject arrivals, and release trailers that are cleared to leave.
 * Same RPC layer as the control tower — no shortcut writes.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, PageBody, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DoorOpen, LogIn, LogOut, ShieldCheck, XCircle, Clock } from "lucide-react";
import { format } from "date-fns";
import { useWarehouses } from "@/features/warehouse/dock/useDockScheduling";
import {
  useExpectedAppointments,
  useGateApprove,
  useGateExit,
  useMarkNoShow,
  useYardSlots,
  useYardDocks,
  useYardVisits,
} from "@/features/warehouse/yard/useYard";
import {
  dwellMinutes,
  formatDwell,
  isOnSite,
  VISIT_STATUS_LABEL,
  type VisitRow,
} from "@/features/warehouse/yard/yardModel";
import { GateCheckInDialog } from "@/features/warehouse/yard/GateCheckInDialog";
import { TrailerVisitDrawer } from "@/features/warehouse/yard/TrailerVisitDrawer";

export default function GateConsole() {
  const [warehouseId, setWarehouseId] = useState("");
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [selected, setSelected] = useState<VisitRow | null>(null);
  const [sealOut, setSealOut] = useState<Record<string, string>>({});

  const warehouses = useWarehouses();
  const effectiveWarehouse = warehouseId || warehouses.data?.[0]?.id || "";
  const visits = useYardVisits(effectiveWarehouse || null);
  const slots = useYardSlots(effectiveWarehouse || null);
  const docks = useYardDocks(effectiveWarehouse || null);
  const expected = useExpectedAppointments(effectiveWarehouse || null);

  const approve = useGateApprove();
  const noShow = useMarkNoShow();
  const exit = useGateExit();

  const all = visits.data ?? [];
  const live = useMemo(() => all.filter(isOnSite), [all]);
  const atGate = live.filter((v) => v.status === "arrived");
  const clearedToLeave = live.filter((v) => v.departure_approved_at);
  const arrivedApptIds = new Set(all.filter(isOnSite).map((v) => v.appointment_id).filter(Boolean));
  const stillExpected = (expected.data ?? []).filter((a) => !arrivedApptIds.has(a.id));
  const selectedLive = selected ? (all.find((v) => v.id === selected.id) ?? selected) : null;

  return (
    <>
      <PageHeader
        title="Gate Console"
        description="Check trailers in and out of site. Every action is recorded against the visit's chain of custody."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/warehouse-app/yard">Control tower</Link>
            </Button>
            <Button size="sm" className="gap-1.5" disabled={!effectiveWarehouse} onClick={() => setCheckInOpen(true)}>
              <LogIn className="h-4 w-4" /> Check in
            </Button>
          </div>
        }
      />

      <PageBody>
        <Select value={effectiveWarehouse} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-full sm:w-[280px] h-11">
            <SelectValue placeholder="Select warehouse" />
          </SelectTrigger>
          <SelectContent>
            {(warehouses.data ?? []).map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {visits.isLoading ? (
          <LoadingState />
        ) : (
          <div className="min-w-0 grid gap-4 @4xl/page:grid-cols-3">
            {/* Expected ------------------------------------------------ */}
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-4 w-4" /> Expected today
                  </span>
                  <Badge variant="secondary">{stillExpected.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stillExpected.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">Nothing outstanding.</p>
                ) : (
                  stillExpected.map((a) => (
                    <div key={a.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{a.trailer_ref || a.appointment_no || a.appointment_type}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {format(new Date(a.window_start), "HH:mm")}–{format(new Date(a.window_end), "HH:mm")}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {a.appointment_type} · {a.driver_name || "driver unknown"}
                      </p>
                      <Button size="sm" className="w-full mt-2 gap-1.5" onClick={() => setCheckInOpen(true)}>
                        <LogIn className="h-3.5 w-3.5" /> Check in
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* At the gate --------------------------------------------- */}
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4" /> Awaiting clearance
                  </span>
                  <Badge variant="secondary">{atGate.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {atGate.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">Gate is clear.</p>
                ) : (
                  atGate.map((v) => (
                    <div key={v.id} className="rounded-md border p-3">
                      <button type="button" className="text-left w-full" onClick={() => setSelected(v)}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{v.trailer_ref}</span>
                          <Badge variant="outline" className="text-[10px]">{formatDwell(dwellMinutes(v))}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {v.carrier?.name ?? "Walk-in"} · {v.driver_name || "driver unknown"}
                        </p>
                      </button>
                      <div className="flex gap-2 mt-2">
                        <Button
                          size="sm"
                          className="flex-1 gap-1.5"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({ visitId: v.id, approved: true })}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" /> Clear
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 text-destructive"
                          disabled={noShow.isPending}
                          onClick={() => noShow.mutate({ visitId: v.id })}
                        >
                          <XCircle className="h-3.5 w-3.5" /> Reject
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Ready to leave ------------------------------------------ */}
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <LogOut className="h-4 w-4" /> Cleared to leave
                  </span>
                  <Badge variant="secondary">{clearedToLeave.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {clearedToLeave.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No trailer is cleared for departure. Supervisors clear trailers from the control tower once
                    open work is closed.
                  </p>
                ) : (
                  clearedToLeave.map((v) => (
                    <div key={v.id} className="rounded-md border p-3">
                      <button type="button" className="text-left w-full" onClick={() => setSelected(v)}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{v.trailer_ref}</span>
                          <Badge variant="outline" className="text-[10px]">{VISIT_STATUS_LABEL[v.status]}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          On site {formatDwell(dwellMinutes(v))} · seal in {v.seal_in || "—"}
                        </p>
                      </button>
                      <div className="flex gap-2 mt-2">
                        <Input
                          className="h-9"
                          placeholder="Exit seal"
                          value={sealOut[v.id] ?? ""}
                          onChange={(e) => setSealOut((s) => ({ ...s, [v.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          className="gap-1.5"
                          disabled={exit.isPending}
                          onClick={() => exit.mutate({ visitId: v.id, sealOut: (sealOut[v.id] ?? "").trim() || null })}
                        >
                          <LogOut className="h-3.5 w-3.5" /> Exit
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </PageBody>

      <GateCheckInDialog
        open={checkInOpen}
        onOpenChange={setCheckInOpen}
        warehouseId={effectiveWarehouse}
        onCheckedIn={setSelected}
      />
      <TrailerVisitDrawer
        visit={selectedLive}
        slots={slots.data ?? []}
        docks={docks.data ?? []}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
