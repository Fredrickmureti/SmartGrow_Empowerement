/**
 * CycleCountPlanner — creates a `wms_count_session` for a warehouse and
 * (optionally) a subset of locations. Snapshots every matching row in
 * `stock_quants` as the session's expected quantities.
 *
 * Phase 4c (ADR 0083). All writes go through `create_count_session`;
 * the client never inserts sessions or lines directly. On success the
 * operator is routed straight into the count screen.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { PageHeader, PageBody, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, ListChecks } from "lucide-react";

interface Warehouse { id: string; name: string; }
interface Location { id: string; name: string; code: string | null; }

export default function CycleCountPlanner() {
  const nav = useNavigate();
  const [warehouseId, setWarehouseId] = useState("");
  const [strategy, setStrategy] = useState<"abc" | "random" | "targeted">("targeted");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  // Blind counting is the enterprise default: hide the expected figure so
  // the count is evidence, not confirmation.
  const [isBlind, setIsBlind] = useState(true);
  const [assignTo, setAssignTo] = useState("");

  const { data: operators } = useQuery({
    queryKey: ["count-operators"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .order("full_name")
        .limit(200);
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string | null }[];
    },
  });

  const { data: warehouses } = useQuery({
    queryKey: ["warehouses-for-count"],
    queryFn: async () => {
      const { data, error } = await supabase.from("warehouses").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as Warehouse[];
    },
  });

  const { data: locations } = useQuery({
    queryKey: ["locations-for-count", warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, name, code")
        .eq("warehouse_id", warehouseId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Location[];
    },
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("create_count_session", {
        p_warehouse_id: warehouseId,
        p_strategy: strategy,
        p_location_ids: selected.size ? Array.from(selected) : null,
        p_notes: notes || null,
        p_is_blind: isBlind,
        p_assign_to: assignTo || null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (sessionId) => {
      toast.success("Count session opened");
      nav(`/warehouse-app/counts/${sessionId}`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const blindHint = isBlind
    ? "Counters will not see the expected quantity — the strongest guard against counting to the system figure."
    : "Counters can see the expected quantity. Faster, but far weaker as a control.";

  return (
    <>
      <PageHeader
        title="New cycle count"
        description="Snapshot on-hand quantities and open a scan-first count session."
        actions={
          <Button variant="outline" asChild>
            <Link to="/warehouse-app/counts"><ArrowLeft className="h-4 w-4 mr-2" /> Sessions</Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Scope">
          <div className="space-y-4">
            <div>
              <Label>Warehouse</Label>
              <select
                className="border rounded px-2 py-1 w-full bg-background"
                value={warehouseId}
                onChange={(e) => { setWarehouseId(e.target.value); setSelected(new Set()); }}
              >
                <option value="">Select warehouse…</option>
                {(warehouses ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Strategy</Label>
              <select
                className="border rounded px-2 py-1 bg-background"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as typeof strategy)}
              >
                <option value="targeted">Targeted (chosen locations)</option>
                <option value="abc">ABC (velocity-based)</option>
                <option value="random">Random sample</option>
              </select>
            </div>
            {warehouseId && (
              <div>
                <Label>Locations {selected.size > 0 && <span className="text-muted-foreground text-xs">({selected.size} selected — leave empty for whole warehouse)</span>}</Label>
                <div className="min-w-0 max-h-56 overflow-auto border rounded p-2 grid grid-cols-2 gap-1 text-sm">
                  {(locations ?? []).map((l) => (
                    <label key={l.id} className="flex items-center gap-2">
                      <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                      <span className="font-mono">{l.code ?? "—"}</span> {l.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="rounded border p-3 space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isBlind}
                  onChange={(e) => setIsBlind(e.target.checked)}
                />
                Hide the expected quantity from counters
              </label>
              <p className="text-xs text-muted-foreground">{blindHint}</p>
            </div>
            <div>
              <Label>Assign to</Label>
              <select
                className="border rounded px-2 py-1 w-full bg-background"
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
              >
                <option value="">Leave in the shared task queue</option>
                {(operators ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.full_name ?? o.id}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                A count task is created for every bin in scope so the work shows up alongside
                picking and putaway.
              </p>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <Button disabled={!warehouseId || create.isPending} onClick={() => create.mutate()}>
              <ListChecks className="h-4 w-4 mr-2" /> Open count session
            </Button>
          </div>
        </Section>
      </PageBody>
    </>
  );
}
