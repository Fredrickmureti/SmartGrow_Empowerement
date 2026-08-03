/**
 * ReturnLpnRail — the plates involved in one return (Returns audit, Phase 7.1).
 *
 * Returned goods arrive on an inbound plate (`lpn_id`) and may leave on a
 * different one after disposition (`lpn_out_id`). The rail shows both so the
 * operator can see, without leaving the console, which handling units the
 * return touches and where each one currently sits.
 *
 * Read-only by design: plate lifecycle actions belong to the LPN subsystem
 * and its own FSM-driven rail.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Boxes } from "lucide-react";
import { StatusBadge } from "@/design-system";
import type { ReturnLine } from "./returnsModel";

interface PlateRow {
  id: string;
  code: string;
  status: string;
  lpn_type: string | null;
  current_location_id: string | null;
}

const PLATE_TONE: Record<string, "info" | "warning" | "success" | "neutral" | "danger"> = {
  open: "info",
  sealed: "success",
  in_transit: "warning",
  dispatched: "warning",
  received: "success",
  retired: "neutral",
  cancelled: "neutral",
};

export function ReturnLpnRail({ lines }: { lines: ReturnLine[] }) {
  const plateIds = useMemo(() => {
    const ids = new Set<string>();
    for (const l of lines) {
      if (l.lpn_id) ids.add(l.lpn_id);
      if (l.lpn_out_id) ids.add(l.lpn_out_id);
    }
    return [...ids].sort();
  }, [lines]);

  const { data: plates } = useQuery({
    queryKey: ["wms-return-lpn-rail", plateIds],
    enabled: plateIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_license_plates" as any)
        .select("id, code, status, lpn_type, current_location_id")
        .in("id", plateIds);
      if (error) throw error;
      return (data ?? []) as unknown as PlateRow[];
    },
  });

  if (plateIds.length === 0) return null;

  const inbound = new Set(lines.map((l) => l.lpn_id).filter(Boolean) as string[]);
  const rows = plates ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Boxes className="h-4 w-4" /> Handling units
        <span className="text-xs font-normal text-muted-foreground">
          {plateIds.length} plate{plateIds.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.length === 0 ? (
          <span className="text-xs text-muted-foreground">Loading plates…</span>
        ) : (
          rows.map((p) => (
            <div key={p.id} className="rounded-md border px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">{p.code}</span>
                <StatusBadge tone={PLATE_TONE[p.status] ?? "neutral"}>
                  {p.status.replace(/_/g, " ")}
                </StatusBadge>
              </div>
              <div className="text-xs text-muted-foreground">
                {inbound.has(p.id) ? "Inbound" : "Outbound"}
                {p.lpn_type ? ` · ${p.lpn_type.replace(/_/g, " ")}` : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
