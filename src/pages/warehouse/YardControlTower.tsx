/**
 * Yard Control Tower (ADR 0086) — the supervisor surface for the yard.
 *
 * Replaces the legacy Yard Board. Three coordinated views over one live
 * dataset:
 *   • Map  — zoned spatial layout, drag a trailer onto a slot to relocate
 *   • Flow — queue lanes + dock face, drag onto a dock to assign
 *   • Log  — every visit today with dwell, including closed ones
 *
 * Every write goes through the gate-aware RPC layer in `useYard`; this
 * page never writes `wms_trailer_visits` directly.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ParkingSquare, Plus, LogIn, Truck, CalendarClock, Search } from "lucide-react";
import { useWarehouses } from "@/features/warehouse/dock/useDockScheduling";
import {
  useRelocateTrailer,
  useAssignTrailerToDock,
  useSetSlotBlocked,
  useYardDocks,
  useYardSlots,
  useYardVisits,
} from "@/features/warehouse/yard/useYard";
import {
  dwellMinutes,
  formatDwell,
  isOnSite,
  VISIT_STATUS_LABEL,
  type VisitRow,
  type YardSlotRow,
} from "@/features/warehouse/yard/yardModel";
import { deriveYardKpis, YardKpiStrip } from "@/features/warehouse/yard/YardKpiStrip";
import { YardMap } from "@/features/warehouse/yard/YardMap";
import { YardLanes } from "@/features/warehouse/yard/YardLanes";
import { TrailerChip } from "@/features/warehouse/yard/TrailerChip";
import { TrailerVisitDrawer } from "@/features/warehouse/yard/TrailerVisitDrawer";
import { GateCheckInDialog } from "@/features/warehouse/yard/GateCheckInDialog";
import { YardSlotDialog } from "@/features/warehouse/yard/YardSlotDialog";
import { format } from "date-fns";

export default function YardControlTower() {
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<VisitRow | null>(null);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [slotDialog, setSlotDialog] = useState<{ open: boolean; slot: YardSlotRow | null }>({
    open: false,
    slot: null,
  });
  const [dragging, setDragging] = useState<VisitRow | null>(null);

  const warehouses = useWarehouses();
  const effectiveWarehouse = warehouseId || warehouses.data?.[0]?.id || "";
  const visits = useYardVisits(effectiveWarehouse || null);
  const slots = useYardSlots(effectiveWarehouse || null);
  const docks = useYardDocks(effectiveWarehouse || null);

  const relocate = useRelocateTrailer();
  const assignDock = useAssignTrailerToDock();
  const setBlocked = useSetSlotBlocked();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const allVisits = visits.data ?? [];
  const liveVisits = useMemo(() => allVisits.filter(isOnSite), [allVisits]);
  const kpis = useMemo(() => deriveYardKpis(allVisits, slots.data ?? []), [allVisits, slots.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allVisits;
    return allVisits.filter(
      (v) =>
        v.trailer_ref.toLowerCase().includes(q) ||
        (v.driver_name ?? "").toLowerCase().includes(q) ||
        (v.carrier?.name ?? "").toLowerCase().includes(q) ||
        (v.appointment?.appointment_no ?? "").toLowerCase().includes(q),
    );
  }, [allVisits, search]);

  // Keep the open drawer in sync with realtime updates.
  const selectedLive = selected ? (allVisits.find((v) => v.id === selected.id) ?? selected) : null;

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const visit = e.active.data.current?.visit as VisitRow | undefined;
    const overId = String(e.over?.id ?? "");
    if (!visit || !overId) return;
    if (overId.startsWith("slot:")) {
      const slotId = overId.slice(5);
      if (visit.yard_slot_id === slotId) return;
      relocate.mutate({ visitId: visit.id, slotId });
    } else if (overId.startsWith("dock:")) {
      const dockId = overId.slice(5);
      if (visit.dock_id === dockId) return;
      assignDock.mutate({ visitId: visit.id, dockId });
    }
  }

  return (
    <>
      <PageHeader
        title="Yard Control Tower"
        description="Live trailer visibility from gate to dock to departure — dwell, appointments, seals and chain of custody."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/warehouse-app/yard/gate">Gate console</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/warehouse-app/yard/trailers">Trailer register</Link>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <Link to="/warehouse-app/schedule">
                <CalendarClock className="h-3.5 w-3.5" /> Dock schedule
              </Link>
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!effectiveWarehouse}
              onClick={() => setCheckInOpen(true)}
            >
              <LogIn className="h-3.5 w-3.5" /> Check in trailer
            </Button>
          </div>
        }
      />

      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={effectiveWarehouse} onValueChange={setWarehouseId}>
            <SelectTrigger className="w-[240px] h-9">
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
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-9 pl-7 w-[260px]"
              placeholder="Trailer, driver, carrier, appointment"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!effectiveWarehouse}
            onClick={() => setSlotDialog({ open: true, slot: null })}
          >
            <Plus className="h-3.5 w-3.5" /> Yard slot
          </Button>
        </div>

        <YardKpiStrip kpis={kpis} />

        {visits.isLoading || slots.isLoading ? (
          <LoadingState />
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current?.visit as VisitRow) ?? null)}
            onDragCancel={() => setDragging(null)}
            onDragEnd={onDragEnd}
          >
            <Tabs defaultValue="map">
              <TabsList>
                <TabsTrigger value="map">Yard map</TabsTrigger>
                <TabsTrigger value="flow">Flow board</TabsTrigger>
                <TabsTrigger value="log">Visit log</TabsTrigger>
              </TabsList>

              <TabsContent value="map" className="pt-4 space-y-4">
                <YardMap
                  slots={slots.data ?? []}
                  visits={liveVisits}
                  onOpenVisit={setSelected}
                  onEditSlot={(s) => setSlotDialog({ open: true, slot: s })}
                  onToggleBlocked={(s) => setBlocked.mutate({ slotId: s.id, blocked: s.status !== "blocked" })}
                  onAddSlot={() => setSlotDialog({ open: true, slot: null })}
                />
                {liveVisits.some((v) => v.status === "arrived" && !v.yard_slot_id) && (
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-xs text-muted-foreground mb-2">
                        Unparked at the gate — drag onto a slot to park.
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {liveVisits
                          .filter((v) => v.status === "arrived" && !v.yard_slot_id)
                          .map((v) => (
                            <div key={v.id} className="w-[200px]">
                              <TrailerChip visit={v} onOpen={setSelected} compact />
                            </div>
                          ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="flow" className="pt-4">
                <YardLanes visits={liveVisits} docks={docks.data ?? []} onOpenVisit={setSelected} />
              </TabsContent>

              <TabsContent value="log" className="pt-4">
                <Section title="Visits" description="Most recent first, including closed visits.">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Trailer</TableHead>
                        <TableHead>Carrier</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Position</TableHead>
                        <TableHead>Arrived</TableHead>
                        <TableHead className="text-right">Dwell</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                            No trailer visits recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filtered.map((v) => (
                          <TableRow key={v.id} className="cursor-pointer" onClick={() => setSelected(v)}>
                            <TableCell className="font-medium">
                              <span className="flex items-center gap-1.5">
                                <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                                {v.trailer_ref}
                              </span>
                            </TableCell>
                            <TableCell>{v.carrier?.name ?? "Walk-in"}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{VISIT_STATUS_LABEL[v.status]}</Badge>
                            </TableCell>
                            <TableCell>{v.dock?.name || v.dock?.code || v.slot?.code || "—"}</TableCell>
                            <TableCell>{format(new Date(v.arrived_at), "dd MMM HH:mm")}</TableCell>
                            <TableCell className="text-right">{formatDwell(dwellMinutes(v))}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </Section>
              </TabsContent>
            </Tabs>

            <DragOverlay>
              {dragging ? (
                <div className="w-[200px]">
                  <TrailerChip visit={dragging} onOpen={() => {}} compact draggable={false} />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </PageBody>

      <GateCheckInDialog
        open={checkInOpen}
        onOpenChange={setCheckInOpen}
        warehouseId={effectiveWarehouse}
        onCheckedIn={setSelected}
      />
      <YardSlotDialog
        open={slotDialog.open}
        onOpenChange={(o) => setSlotDialog((s) => ({ ...s, open: o }))}
        warehouseId={effectiveWarehouse}
        slot={slotDialog.slot}
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
