/**
 * DraftWaveConsole — Phase 5 supervisor release console.
 *
 * Auto-waving places sales-order allocations into **draft** waves
 * (`wms_enqueue_order_for_wave` fired by the allocation trigger). Nothing
 * becomes operator work until a supervisor releases it here — the same
 * separation SAP EWM draws between wave *creation* and wave *release*.
 *
 * The console answers the three questions a supervisor actually has
 * before releasing: what is on the wave, is there stock to cover it, and
 * what happens if I cancel instead. Release goes through
 * `release_pick_wave` (reservation-consistent, idempotent); cancel goes
 * through the aggregate FSM, which unwinds tasks and reservations.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Rocket, Waves } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  EmptyState,
  LoadingState,
  Section,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { CancelAggregateButton } from "./CancelAggregateButton";
import { useReleaseWave } from "./useDomainOperations";

interface DraftWaveLine {
  id: string;
  product_id: string;
  lot_number: string | null;
  quantity_ordered: number;
  quantity_picked: number;
  sales_order_id: string | null;
  product: { name: string | null; sku: string | null } | null;
}

interface DraftWave {
  id: string;
  wave_number: string;
  state: string;
  row_version: number;
  strategy: string;
  notes: string | null;
  created_at: string;
  warehouse_id: string;
  lines: DraftWaveLine[];
}

interface Props {
  businessId: string | undefined;
  warehouseNames: Record<string, string>;
}

export function DraftWaveConsole({ businessId, warehouseNames }: Props) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const release = useReleaseWave();

  const { data: waves, isLoading } = useQuery({
    queryKey: ["wms-draft-waves", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select(
          "id, wave_number, state, row_version, strategy, notes, created_at, warehouse_id, lines:wms_pick_wave_lines(id, product_id, lot_number, quantity_ordered, quantity_picked, sales_order_id, product:product_id(name, sku))",
        )
        .eq("business_id", businessId!)
        .eq("state", "draft")
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as unknown as DraftWave[];
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["wms-draft-waves"] });
    queryClient.invalidateQueries({ queryKey: ["wms-pick-waves"] });
  };

  return (
    <Section
      title="Awaiting release"
      description="Draft waves built automatically from allocated sales orders. Releasing generates pick tasks and moves the reservation from the order to the wave."
     contentClassName="px-0 pb-0">
      {isLoading ? (
        <LoadingState />
      ) : (waves ?? []).length === 0 ? (
        <EmptyState
          icon={Waves}
          title="No waves awaiting release"
          description="Allocating a sales order automatically builds a draft wave here."
        />
      ) : (
        <ul className="divide-y">
          {waves!.map((w) => {
            const orders = new Set(
              w.lines.map((l) => l.sales_order_id).filter(Boolean),
            ).size;
            const units = w.lines.reduce(
              (sum, l) => sum + Number(l.quantity_ordered ?? 0),
              0,
            );
            const open = expanded === w.id;
            return (
              <li key={w.id} className="p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    aria-label={open ? "Collapse wave" : "Expand wave"}
                    onClick={() => setExpanded(open ? null : w.id)}
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                  <StatusBadge tone="neutral">draft</StatusBadge>
                  <span className="font-mono">{w.wave_number}</span>
                  <span className="text-xs text-muted-foreground">
                    {warehouseNames[w.warehouse_id] ?? "—"} · {w.strategy}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {orders} order(s) · {w.lines.length} line(s) · {units} unit(s)
                  </span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    disabled={release.isPending || w.lines.length === 0}
                    onClick={() =>
                      release.mutate(w.id, { onSuccess: refresh })
                    }
                  >
                    <Rocket className="mr-2 h-4 w-4" /> Release
                  </Button>
                  <CancelAggregateButton
                    aggregate="wave"
                    id={w.id}
                    rowVersion={w.row_version}
                    state={w.state}
                    onCancelled={refresh}
                  />
                </div>

                {open && (
                  <div className="mt-3 overflow-auto rounded border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="p-2">Product</th>
                          <th className="p-2">SKU</th>
                          <th className="p-2">Lot</th>
                          <th className="p-2 text-right">Ordered</th>
                          <th className="p-2 text-right">Picked</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.lines.map((l) => (
                          <tr key={l.id} className="border-t">
                            <td className="p-2">{l.product?.name ?? "—"}</td>
                            <td className="p-2 font-mono text-xs">
                              {l.product?.sku ?? "—"}
                            </td>
                            <td className="p-2">{l.lot_number ?? "—"}</td>
                            <td className="p-2 text-right font-mono">
                              {Number(l.quantity_ordered ?? 0)}
                            </td>
                            <td className="p-2 text-right font-mono">
                              {Number(l.quantity_picked ?? 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export default DraftWaveConsole;
