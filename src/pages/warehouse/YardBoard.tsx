/**
 * Yard Board — Phase 9 (ADR 0080).
 *
 * Live yard-ops signal: check-in trailers, park them in yard slots,
 * assign them to docks, capture inbound/outbound seals, and depart
 * them (with server-computed dwell). All state transitions go through
 * SECURITY DEFINER RPCs:
 *
 *   - check_in_trailer
 *   - assign_trailer_to_dock
 *   - depart_trailer
 *
 * `wms_trailer_visits` is read-only for clients; only `wms_yard_slots`
 * (master data) is written directly here.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ParkingSquare, Plus, LogIn, LogOut, Truck, MapPin, Ban } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useAuth } from "@/contexts/AuthContext";

interface TrailerVisit {
  id: string;
  warehouse_id: string;
  carrier_id: string | null;
  trailer_ref: string;
  driver_name: string | null;
  driver_phone: string | null;
  seal_in: string | null;
  seal_out: string | null;
  yard_slot_id: string | null;
  dock_id: string | null;
  appointment_id: string | null;
  arrived_at: string;
  docked_at: string | null;
  departed_at: string | null;
  dwell_minutes: number | null;
  status: "arrived" | "in_yard" | "at_dock" | "departed" | "no_show";
  carrier?: { name: string } | null;
  slot?: { code: string } | null;
  dock?: { name: string; code: string | null } | null;
}

interface YardSlot {
  id: string;
  code: string;
  slot_type: "inbound" | "outbound" | "either" | "hazmat" | "reefer";
  status: "available" | "occupied" | "blocked";
  warehouse_id: string;
}

interface Dock {
  id: string;
  name: string;
  code: string | null;
  warehouse_id: string;
}

const STATUS_TONE = {
  arrived: "info",
  in_yard: "warning",
  at_dock: "success",
  departed: "neutral",
  no_show: "danger",
} as const;

const SLOT_TONE = {
  available: "bg-emerald-100 border-emerald-300 text-emerald-900",
  occupied: "bg-amber-100 border-amber-300 text-amber-900",
  blocked: "bg-rose-100 border-rose-300 text-rose-900",
} as const;

export default function YardBoard() {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [slotOpen, setSlotOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState<TrailerVisit | null>(null);
  const [departOpen, setDepartOpen] = useState<TrailerVisit | null>(null);
  const [noShowOpen, setNoShowOpen] = useState<TrailerVisit | null>(null);

  const effectiveWarehouseId = useMemo(() => {
    if (warehouseFilter !== "all") return warehouseFilter;
    return warehouses?.[0]?.id ?? null;
  }, [warehouseFilter, warehouses]);

  const { data: visits, isLoading: visitsLoading } = useQuery({
    queryKey: ["wms-trailer-visits", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_trailer_visits")
        .select(
          "id,warehouse_id,carrier_id,trailer_ref,driver_name,driver_phone,seal_in,seal_out," +
            "yard_slot_id,dock_id,appointment_id,arrived_at,docked_at,departed_at,dwell_minutes,status," +
            "carrier:carriers(name)," +
            "slot:wms_yard_slots(code)," +
            "dock:warehouse_docks(name,code)"
        )
        .eq("business_id", currentBusiness!.id)
        .order("arrived_at", { ascending: false })
        .limit(200);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as TrailerVisit[];
    },
  });

  const { data: slots, isLoading: slotsLoading } = useQuery({
    queryKey: ["wms-yard-slots", currentBusiness?.id, warehouseFilter],
    enabled: !!currentBusiness?.id,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_yard_slots")
        .select("id,code,slot_type,status,warehouse_id")
        .eq("business_id", currentBusiness!.id)
        .order("code");
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as YardSlot[];
    },
  });

  const activeVisits = useMemo(
    () => (visits ?? []).filter((v) => v.status !== "departed" && v.status !== "no_show"),
    [visits]
  );
  const closedVisits = useMemo(
    () => (visits ?? []).filter((v) => v.status === "departed" || v.status === "no_show").slice(0, 20),
    [visits]
  );

  const slotToVisit = useMemo(() => {
    const map = new Map<string, TrailerVisit>();
    for (const v of activeVisits) {
      if (v.yard_slot_id) map.set(v.yard_slot_id, v);
    }
    return map;
  }, [activeVisits]);

  return (
    <>
      <PageHeader
        eyebrow="Warehouse"
        title="Yard & trailers"
        description="Live arrivals, yard slots, dock assignment and seal capture."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
              <SelectTrigger className="w-56"><SelectValue placeholder="All warehouses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All warehouses</SelectItem>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => setSlotOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> Yard slot
            </Button>
            <Button onClick={() => setCheckInOpen(true)} disabled={!effectiveWarehouseId}>
              <LogIn className="h-4 w-4 mr-2" /> Check in trailer
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Arrivals board */}
          <div className="xl:col-span-2 space-y-6">
            <Section title="Active visits" description="Live queue — refreshes every 15s.">
              {visitsLoading ? (
                <LoadingState />
              ) : activeVisits.length === 0 ? (
                <EmptyState icon={Truck} title="No active trailers" description="Check in an arriving trailer to begin." />
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="text-left p-3">Trailer</th>
                            <th className="text-left p-3">Carrier / Driver</th>
                            <th className="text-left p-3">Location</th>
                            <th className="text-left p-3">Seal in</th>
                            <th className="text-left p-3">Arrived</th>
                            <th className="text-left p-3">Status</th>
                            <th className="text-right p-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeVisits.map((v) => (
                            <tr key={v.id} className="border-t">
                              <td className="p-3 font-mono text-xs">{v.trailer_ref}</td>
                              <td className="p-3">
                                <div>{v.carrier?.name ?? "—"}</div>
                                {v.driver_name && (
                                  <div className="text-xs text-muted-foreground">{v.driver_name}</div>
                                )}
                              </td>
                              <td className="p-3 text-xs">
                                {v.dock ? (
                                  <span className="font-mono">Dock {v.dock.code ?? v.dock.name}</span>
                                ) : v.slot ? (
                                  <span className="font-mono">Slot {v.slot.code}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="p-3 font-mono text-xs">{v.seal_in ?? "—"}</td>
                              <td className="p-3 text-xs text-muted-foreground">
                                {new Date(v.arrived_at).toLocaleString()}
                              </td>
                              <td className="p-3">
                                <StatusBadge tone={STATUS_TONE[v.status] ?? "neutral"}>
                                  {v.status.replace("_", " ")}
                                </StatusBadge>
                              </td>
                              <td className="p-3 text-right space-x-2 whitespace-nowrap">
                                {v.status !== "at_dock" && (
                                  <Button size="sm" variant="outline" onClick={() => setAssignOpen(v)}>
                                    <MapPin className="h-3.5 w-3.5 mr-1" /> To dock
                                  </Button>
                                )}
                                {v.status !== "at_dock" && (
                                  <Button size="sm" variant="ghost" onClick={() => setNoShowOpen(v)}>
                                    <Ban className="h-3.5 w-3.5 mr-1" /> No-show
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" onClick={() => setDepartOpen(v)}>
                                  <LogOut className="h-3.5 w-3.5 mr-1" /> Depart
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </Section>

            {closedVisits.length > 0 && (
              <Section title="Recently closed" description="Last 20 completed visits with dwell.">
                <Card>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="text-left p-3">Trailer</th>
                            <th className="text-left p-3">Carrier</th>
                            <th className="text-left p-3">Seal in → out</th>
                            <th className="text-right p-3">Dwell (min)</th>
                            <th className="text-left p-3">Departed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {closedVisits.map((v) => (
                            <tr key={v.id} className="border-t">
                              <td className="p-3 font-mono text-xs">{v.trailer_ref}</td>
                              <td className="p-3">{v.carrier?.name ?? "—"}</td>
                              <td className="p-3 font-mono text-xs">
                                {v.seal_in ?? "—"} → {v.seal_out ?? "—"}
                              </td>
                              <td className="p-3 text-right">
                                {v.dwell_minutes != null ? Math.round(v.dwell_minutes) : "—"}
                              </td>
                              <td className="p-3 text-xs text-muted-foreground">
                                {v.departed_at ? new Date(v.departed_at).toLocaleString() : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </Section>
            )}
          </div>

          {/* Yard map */}
          <div>
            <Section title="Yard map" description="Slot occupancy at a glance.">
              {slotsLoading ? (
                <LoadingState />
              ) : !slots || slots.length === 0 ? (
                <EmptyState
                  icon={ParkingSquare}
                  title="No yard slots defined"
                  description="Add slots to track where trailers park."
                />
              ) : (
                <Card>
                  <CardContent className="p-4">
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {slots.map((s) => {
                        const occupant = slotToVisit.get(s.id);
                        return (
                          <div
                            key={s.id}
                            className={`rounded-md border p-2 text-center ${SLOT_TONE[s.status]}`}
                            title={occupant ? `${occupant.trailer_ref} — ${occupant.carrier?.name ?? ""}` : s.slot_type}
                          >
                            <div className="font-mono text-sm font-semibold">{s.code}</div>
                            <div className="text-[10px] uppercase tracking-wide opacity-70">
                              {s.slot_type}
                            </div>
                            {occupant && (
                              <div className="text-[10px] font-mono mt-1 truncate">
                                {occupant.trailer_ref}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex gap-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-3 h-3 rounded bg-emerald-200 border border-emerald-300" /> Available
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-3 h-3 rounded bg-amber-200 border border-amber-300" /> Occupied
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-3 h-3 rounded bg-rose-200 border border-rose-300" /> Blocked
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )}
            </Section>
          </div>
        </div>
      </PageBody>

      <CheckInDialog
        open={checkInOpen}
        onOpenChange={setCheckInOpen}
        defaultWarehouseId={effectiveWarehouseId}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["wms-trailer-visits"] });
          qc.invalidateQueries({ queryKey: ["wms-yard-slots"] });
        }}
      />
      <NewSlotDialog
        open={slotOpen}
        onOpenChange={setSlotOpen}
        defaultWarehouseId={effectiveWarehouseId}
        onCreated={() => qc.invalidateQueries({ queryKey: ["wms-yard-slots"] })}
      />
      <AssignDockDialog
        visit={assignOpen}
        onClose={() => setAssignOpen(null)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["wms-trailer-visits"] });
          qc.invalidateQueries({ queryKey: ["wms-yard-slots"] });
        }}
      />
      <DepartDialog
        visit={departOpen}
        onClose={() => setDepartOpen(null)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["wms-trailer-visits"] });
          qc.invalidateQueries({ queryKey: ["wms-yard-slots"] });
        }}
      />
      <NoShowDialog
        visit={noShowOpen}
        onClose={() => setNoShowOpen(null)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["wms-trailer-visits"] });
          qc.invalidateQueries({ queryKey: ["wms-yard-slots"] });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function CheckInDialog({
  open,
  onOpenChange,
  defaultWarehouseId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultWarehouseId: string | null;
  onDone: () => void;
}) {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string>(defaultWarehouseId ?? "");
  const [trailerRef, setTrailerRef] = useState("");
  const [carrierId, setCarrierId] = useState<string>("");
  const [driverName, setDriverName] = useState("");
  const [driverPhone, setDriverPhone] = useState("");
  const [sealIn, setSealIn] = useState("");

  const { data: carriers } = useQuery({
    queryKey: ["yard-carriers", currentBusiness?.id],
    enabled: open && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("carriers")
        .select("id,name")
        .eq("business_id", currentBusiness!.id)
        .order("name")
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const wh = warehouseId || defaultWarehouseId;
      if (!wh) throw new Error("Pick a warehouse");
      if (!trailerRef.trim()) throw new Error("Trailer reference is required");
      const { error } = await supabase.rpc("check_in_trailer", {
        p_warehouse_id: wh,
        p_trailer_ref: trailerRef.trim(),
        p_carrier_id: carrierId || null,
        p_driver_name: driverName || null,
        p_driver_phone: driverPhone || null,
        p_seal_in: sealIn || null,
        p_appointment_id: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trailer checked in");
      setTrailerRef("");
      setCarrierId("");
      setDriverName("");
      setDriverPhone("");
      setSealIn("");
      onDone();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Check in trailer</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Warehouse</Label>
            <Select value={warehouseId || defaultWarehouseId || ""} onValueChange={setWarehouseId}>
              <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Trailer reference</Label>
            <Input value={trailerRef} onChange={(e) => setTrailerRef(e.target.value)} placeholder="TRL-1234" />
          </div>
          <div>
            <Label>Carrier</Label>
            <Select value={carrierId} onValueChange={setCarrierId}>
              <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
              <SelectContent>
                {carriers?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Driver name</Label><Input value={driverName} onChange={(e) => setDriverName(e.target.value)} /></div>
            <div><Label>Driver phone</Label><Input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} /></div>
          </div>
          <div>
            <Label>Inbound seal</Label>
            <Input value={sealIn} onChange={(e) => setSealIn(e.target.value)} placeholder="SEAL-…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? "Checking in…" : "Check in"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewSlotDialog({
  open,
  onOpenChange,
  defaultWarehouseId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultWarehouseId: string | null;
  onCreated: () => void;
}) {
  const { currentBusiness } = useBusinesses();
  const { warehouses } = useWarehouses();
  const { user } = useAuth();
  const [warehouseId, setWarehouseId] = useState<string>(defaultWarehouseId ?? "");
  const [code, setCode] = useState("");
  const [slotType, setSlotType] = useState<string>("either");
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const wh = warehouses?.find((w) => w.id === (warehouseId || defaultWarehouseId));
      if (!wh || !currentBusiness) throw new Error("Warehouse required");
      if (!code.trim()) throw new Error("Code is required");
      const { error } = await supabase.from("wms_yard_slots").insert({
        organization_id:
          (wh as unknown as { organization_id: string }).organization_id ?? currentBusiness.organization_id,
        business_id: currentBusiness.id,
        warehouse_id: wh.id,
        code: code.trim(),
        slot_type: slotType,
        notes: notes || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Yard slot created");
      setCode("");
      setNotes("");
      onCreated();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New yard slot</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Warehouse</Label>
            <Select value={warehouseId || defaultWarehouseId || ""} onValueChange={setWarehouseId}>
              <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Y-01" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={slotType} onValueChange={setSlotType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="either">Either</SelectItem>
                  <SelectItem value="inbound">Inbound</SelectItem>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="hazmat">Hazmat</SelectItem>
                  <SelectItem value="reefer">Reefer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDockDialog({
  visit,
  onClose,
  onDone,
}: {
  visit: TrailerVisit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dockId, setDockId] = useState<string>("");

  const { data: docks } = useQuery({
    queryKey: ["yard-docks", visit?.warehouse_id],
    enabled: !!visit?.warehouse_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouse_docks")
        .select("id,name,code,warehouse_id")
        .eq("warehouse_id", visit!.warehouse_id)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Dock[];
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!visit || !dockId) throw new Error("Pick a dock");
      const { error } = await supabase.rpc("assign_trailer_to_dock", {
        p_visit_id: visit.id,
        p_dock_id: dockId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trailer at dock");
      setDockId("");
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={!!visit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign to dock</DialogTitle>
        </DialogHeader>
        {visit && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Trailer <span className="font-mono">{visit.trailer_ref}</span>
              {visit.carrier?.name ? ` — ${visit.carrier.name}` : ""}
            </div>
            <div>
              <Label>Dock</Label>
              <Select value={dockId} onValueChange={setDockId}>
                <SelectTrigger><SelectValue placeholder="Select dock" /></SelectTrigger>
                <SelectContent>
                  {docks?.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code ? `${d.code} — ${d.name}` : d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || !dockId}>
            {submit.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DepartDialog({
  visit,
  onClose,
  onDone,
}: {
  visit: TrailerVisit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [sealOut, setSealOut] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!visit) return;
      const { error } = await supabase.rpc("depart_trailer", {
        p_visit_id: visit.id,
        p_seal_out: sealOut || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trailer departed");
      setSealOut("");
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={!!visit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Depart trailer</DialogTitle></DialogHeader>
        {visit && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Trailer <span className="font-mono">{visit.trailer_ref}</span>
              {visit.seal_in ? <> · inbound seal <span className="font-mono">{visit.seal_in}</span></> : null}
            </div>
            <div>
              <Label>Outbound seal</Label>
              <Input value={sealOut} onChange={(e) => setSealOut(e.target.value)} placeholder="SEAL-…" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? "Departing…" : "Depart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * No-show closes a visit that never made it to a dock. The server
 * cascade also cancels that trailer's open loading manifests, which
 * unlinks staged cartons and releases the `load` tasks booked against
 * them — otherwise the labour board keeps counting work nobody can do.
 */
function NoShowDialog({
  visit,
  onClose,
  onDone,
}: {
  visit: TrailerVisit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!visit) return;
      const { error } = await supabase.rpc("mark_trailer_no_show", {
        p_visit_id: visit.id,
        p_reason: reason.trim() || "No-show recorded from yard board",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Marked no-show", {
        description: "Open loading manifests cancelled and loading work released.",
      });
      setReason("");
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={!!visit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Mark trailer no-show</DialogTitle></DialogHeader>
        {visit && (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Trailer <span className="font-mono">{visit.trailer_ref}</span> will be closed
              without departing. Any open loading manifest for this visit is cancelled and
              its loading tasks return to the queue.
            </div>
            <div>
              <Label>Reason</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Carrier cancelled, driver never arrived…"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => submit.mutate()}
            disabled={submit.isPending}
          >
            {submit.isPending ? "Marking…" : "Mark no-show"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
