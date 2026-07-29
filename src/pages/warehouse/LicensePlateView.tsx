/**
 * LicensePlateView — LPN detail with move / seal / retire actions.
 * Move goes through the `move_lpn` RPC so the outbox event is guaranteed
 * atomically with the location update.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { PackageOpen, ArrowLeft, MoveRight, Lock, Archive } from "lucide-react";

type LpnStatus = "open" | "sealed" | "shipped" | "retired";

export default function LicensePlateView() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: lpn, isLoading } = useQuery({
    queryKey: ["wms-lpn", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_license_plates")
        .select("*, stock_locations:current_location_id(code, name), parent:parent_lpn_id(code)")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: locations } = useQuery({
    queryKey: ["wms-lpn-loc-options", lpn?.warehouse_id],
    enabled: !!lpn?.warehouse_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, name, structure_level, is_default")
        .eq("warehouse_id", lpn!.warehouse_id!)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: contents } = useQuery({
    queryKey: ["wms-lpn-contents", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_quants")
        .select("id, product_id, quantity, reserved_quantity, lot_number, products:product_id(name, sku)")
        .eq("package_id", id!)
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Putaway suggestions surfaced for whichever task references this plate
  // (usually the freshly staged receiving task). Keeps operators from
  // guessing which bin the WMS ranked #1.
  const { data: suggestions } = useQuery({
    queryKey: ["wms-lpn-suggestions", id],
    enabled: !!id,
    queryFn: async () => {
      const { data: tasks, error: tErr } = await supabase
        .from("wms_tasks")
        .select("id, task_type, state")
        .eq("lpn_id", id!)
        .eq("task_type", "putaway")
        .in("state", ["pending", "assigned", "in_progress"])
        .limit(5);
      if (tErr) throw tErr;
      const taskIds = (tasks ?? []).map((t) => t.id);
      if (!taskIds.length) return [];
      const { data, error } = await supabase
        .from("wms_putaway_suggestions")
        .select("id, task_id, rank, reason, chosen, location:location_id(code, name)")
        .in("task_id", taskIds)
        .order("rank");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDest, setMoveDest] = useState<string>("");
  const [moveNote, setMoveNote] = useState<string>("");

  const move = useMutation({
    mutationFn: async () => {
      if (!id || !moveDest) throw new Error("Choose destination bin");
      const { error } = await supabase.rpc("move_lpn", {
        p_lpn_id: id,
        p_dest_location_id: moveDest,
        p_note: moveNote || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Plate moved");
      setMoveOpen(false); setMoveDest(""); setMoveNote("");
      qc.invalidateQueries({ queryKey: ["wms-lpn", id] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Move failed"),
  });

  const setStatus = useMutation({
    mutationFn: async (input: { toState: string; reason?: string }) => {
      if (!id) throw new Error("No plate");
      const { error } = await supabase.rpc("wms_transition_lpn" as any, {
        _lpn_id: id,
        _to_status: input.toState,
        _expected_version: (lpn as any)?.row_version ?? 0,
        _reason: input.reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wms-lpn", id] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Transition rejected"),
  });


  const currentLoc = useMemo(
    () => (lpn?.stock_locations ? `${lpn.stock_locations.code} · ${lpn.stock_locations.name}` : "—"),
    [lpn],
  );

  if (isLoading) return <LoadingState />;
  if (!lpn) {
    return (
      <EmptyState
        icon={PackageOpen}
        title="License plate not found"
        description="It may have been deleted or you do not have access."
        action={<Button onClick={() => nav("/warehouse-app/plates")}>Back to list</Button>}
      />
    );
  }

  const status = lpn.status as LpnStatus;

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{lpn.code}</span>}
        description={<span className="capitalize">{lpn.lpn_type} plate</span>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/plates"><ArrowLeft className="mr-2 h-4 w-4" /> Back</Link>
            </Button>
            <Button onClick={() => setMoveOpen(true)} disabled={status === "retired" || status === "shipped"}>
              <MoveRight className="mr-2 h-4 w-4" /> Move
            </Button>
            {status === "open" && (
              <Button variant="outline" onClick={() => setStatus.mutate({ toState: "sealed" })}>
                <Lock className="mr-2 h-4 w-4" /> Seal
              </Button>
            )}
            {(status as string) !== "retired" && (status as string) !== "voided" && (
              <Button variant="outline" onClick={() => setStatus.mutate({ toState: "voided", reason: "Manual retire" })}>
                <Archive className="mr-2 h-4 w-4" /> Retire
              </Button>
            )}

          </div>
        }
      />
      <PageBody>
        <Section>
          <div className="grid gap-3 md:grid-cols-3">
            <Card><CardHeader className="pb-1"><CardTitle className="text-xs uppercase text-muted-foreground">Status</CardTitle></CardHeader>
              <CardContent><StatusBadge tone={status === "sealed" ? "warning" : status === "shipped" ? "success" : status === "retired" ? "neutral" : "info"} >{status}</StatusBadge></CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-xs uppercase text-muted-foreground">Current location</CardTitle></CardHeader>
              <CardContent className="text-sm">{currentLoc}</CardContent></Card>
            <Card><CardHeader className="pb-1"><CardTitle className="text-xs uppercase text-muted-foreground">Parent plate</CardTitle></CardHeader>
              <CardContent className="text-sm font-mono">{lpn.parent?.code ?? "—"}</CardContent></Card>
          </div>
        </Section>

        <Section title="Contents" description="Aggregated from stock quants where package_id references this plate.">
          <Card>
            <CardContent className="p-4">
              {(contents ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground">No stock currently addressed to this plate.</div>
              ) : (
                <ul className="text-sm divide-y">
                  {contents!.map((c) => (
                    <li key={c.id} className="py-2 flex justify-between">
                      <span>{c.products?.name ?? c.product_id} <span className="text-muted-foreground">{c.products?.sku ?? ""}</span></span>
                      <span className="font-mono">{Number(c.quantity).toFixed(2)}{c.reserved_quantity ? ` (res ${Number(c.reserved_quantity).toFixed(2)})` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </Section>

        <Section title="Putaway suggestions" description="Bins the WMS ranks for this plate. #1 is preselected on the task destination.">
          <Card>
            <CardContent className="p-4">
              {(suggestions ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground">No open putaway task references this plate.</div>
              ) : (
                <ul className="text-sm divide-y">
                  {suggestions!.map((s) => (
                    <li key={s.id} className="py-2 flex justify-between">
                      <span>
                        <span className="font-mono mr-2">#{s.rank}</span>
                        {s.location?.code ?? "—"} · {s.location?.name ?? ""}
                        <span className="text-muted-foreground ml-2">{s.reason}</span>
                      </span>
                      {s.chosen ? <StatusBadge tone="success">chosen</StatusBadge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Move license plate</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Select value={moveDest} onValueChange={setMoveDest}>
                <SelectTrigger><SelectValue placeholder="Choose destination location" /></SelectTrigger>
                <SelectContent>
                  {(locations ?? []).map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code} · {l.name}{l.is_default ? " (default)" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Textarea placeholder="Optional note" value={moveNote} onChange={(e) => setMoveNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button>
            <Button onClick={() => move.mutate()} disabled={move.isPending || !moveDest}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
