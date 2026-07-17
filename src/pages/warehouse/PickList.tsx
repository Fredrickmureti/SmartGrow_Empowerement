/**
 * PickList — operator screen for a single pick wave.
 *
 * Lists pending pick tasks for the wave. `Confirm` calls
 * `complete_pick_task(p_task_id, p_picked_qty)` — the RPC is the only
 * sanctioned way to close a pick task; it rolls up wave line quantities
 * and advances the wave state when the last task finishes.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { Input } from "@/components/ui/input";
import { ArrowLeft, Check, PackageCheck } from "lucide-react";

interface PickTask {
  id: string;
  state: "pending" | "assigned" | "in_progress" | "done" | "cancelled";
  quantity: number | null;
  product_id: string | null;
  lot_number: string | null;
  source_location_id: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  product: { name: string; sku: string | null } | null;
  source_loc: { code: string; name: string } | null;
}

const STATE_TONE = {
  pending: "neutral",
  assigned: "info",
  in_progress: "warning",
  done: "success",
  cancelled: "danger",
} as const;

export default function PickList() {
  const { waveId } = useParams<{ waveId: string }>();
  const qc = useQueryClient();
  const [pickedQty, setPickedQty] = useState<Record<string, string>>({});

  const { data: wave } = useQuery({
    queryKey: ["wms-pick-wave", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state, warehouse_id, created_at, released_at")
        .eq("id", waveId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: tasks, isLoading } = useQuery({
    queryKey: ["wms-pick-tasks", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, state, quantity, product_id, lot_number, source_location_id, notes, metadata, product:product_id(name, sku), source_loc:source_location_id(code, name)")
        .eq("task_type", "pick")
        .contains("metadata", { wave_id: waveId })
        .order("state")
        .order("priority", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as PickTask[];
    },
  });

  const complete = useMutation({
    mutationFn: async ({ id, qty }: { id: string; qty: number }) => {
      const { error } = await supabase.rpc("complete_pick_task", {
        p_task_id: id,
        p_picked_qty: qty,
        p_lpn_id: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pick confirmed");
      qc.invalidateQueries({ queryKey: ["wms-pick-tasks", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-wave", waveId] });
      qc.invalidateQueries({ queryKey: ["wms-pick-waves"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Pick failed"),
  });

  const open = useMemo(
    () => (tasks ?? []).filter((t) => t.state !== "done" && t.state !== "cancelled"),
    [tasks],
  );
  const done = useMemo(() => (tasks ?? []).filter((t) => t.state === "done"), [tasks]);

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{wave?.wave_number ?? "Wave"}</span>}
        description={wave ? `State: ${wave.state}` : "Loading…"}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/waves"><ArrowLeft className="h-4 w-4 mr-2" /> Waves</Link>
            </Button>
            {wave?.state === "picked" && (
              <Button asChild>
                <Link to={`/warehouse-app/pack/${waveId}`}><PackageCheck className="h-4 w-4 mr-2" /> Pack</Link>
              </Button>
            )}
          </div>
        }
      />
      <PageBody>
        <Section title="Open picks" description="Confirm the picked quantity against each task. Short-picks are allowed.">
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <LoadingState />
              ) : open.length === 0 ? (
                <EmptyState
                  icon={PackageCheck}
                  title="All picks complete"
                  description={wave?.state === "picked" ? "Move to packing." : "Nothing left to pick."}
                />
              ) : (
                <ul className="divide-y">
                  {open.map((t) => {
                    const suggested = t.quantity != null ? String(t.quantity) : "";
                    const val = pickedQty[t.id] ?? suggested;
                    return (
                      <li key={t.id} className="p-3 flex flex-wrap items-center gap-3">
                        <StatusBadge tone={STATE_TONE[t.state]}>{t.state.replace("_", " ")}</StatusBadge>
                        <span className="font-mono text-sm">{t.source_loc?.code ?? "?"}</span>
                        <span className="text-sm flex-1">
                          {t.product?.name ?? "—"}
                          {t.product?.sku ? <span className="text-muted-foreground"> · {t.product.sku}</span> : null}
                          {t.lot_number ? <span className="text-muted-foreground"> · lot {t.lot_number}</span> : null}
                          {t.notes ? <span className="text-warning ml-2">· {t.notes}</span> : null}
                        </span>
                        <div className="text-xs text-muted-foreground">req {Number(t.quantity ?? 0).toFixed(2)}</div>
                        <Input
                          className="w-24"
                          type="number"
                          min="0"
                          step="0.01"
                          value={val}
                          onChange={(e) => setPickedQty((p) => ({ ...p, [t.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          disabled={complete.isPending}
                          onClick={() => complete.mutate({ id: t.id, qty: Number(val || 0) })}
                        >
                          <Check className="h-3.5 w-3.5 mr-1" /> Confirm
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </Section>

        {done.length > 0 && (
          <Section title={`Completed (${done.length})`}>
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {done.map((t) => (
                    <li key={t.id} className="p-3 flex items-center gap-3 text-sm">
                      <StatusBadge tone="success">done</StatusBadge>
                      <span className="font-mono">{t.source_loc?.code ?? "—"}</span>
                      <span className="flex-1">{t.product?.name ?? "—"}</span>
                      <span className="font-mono">{Number(t.quantity ?? 0).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </Section>
        )}
      </PageBody>
    </>
  );
}
