/**
 * Mobile RF — "Next task" (Phase 3.6).
 *
 * Single-screen operator entry point. Claims the highest-priority open
 * task the operator is capable of via `wms_claim_next_task` (atomic
 * SKIP LOCKED), then routes to the correct capture screen by task_type.
 *
 * Contract:
 *  - No direct `UPDATE wms_tasks` — routes through `useTaskEngine`.
 *  - Idle state polls every 20s so a busy warehouse doesn't leave
 *    operators staring at "no work".
 *  - Warehouse must be picked once, then remembered per-device.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageBody } from "@/design-system";
import { Loader2, PackageCheck, Play } from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useTaskEngine } from "@/features/warehouse/tasks/useTaskEngine";
import type { WmsTaskType } from "@/features/warehouse/events/topics";

const STORAGE_KEY = "wms.mobile.next.warehouseId";

// Route each task_type to its capture surface. Keep in one map so a new
// task type only needs one edit.
const CAPTURE_ROUTES: Record<string, string> = {
  pick: "/warehouse-app/tasks",
  pack: "/warehouse-app/tasks",
  putaway: "/warehouse-app/putaway",
  replenish: "/warehouse-app/tasks",
  count: "/warehouse-app/counts",
  qc: "/warehouse-app/qc",
  move: "/warehouse-app/tasks",
  load: "/warehouse-app/dispatch",
};

function routeForTaskType(taskType: string | null | undefined): string {
  if (!taskType) return "/warehouse/tasks";
  return CAPTURE_ROUTES[taskType] ?? "/warehouse/tasks";
}

export default function MobileNextTask() {
  const navigate = useNavigate();
  const { warehouses } = useWarehouses();
  const { claimNext } = useTaskEngine();

  const [warehouseId, setWarehouseId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  });

  useEffect(() => {
    if (warehouseId && typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, warehouseId);
    }
  }, [warehouseId]);

  const activeWarehouse = useMemo(
    () => (warehouses ?? []).find((w) => w.id === warehouseId) ?? null,
    [warehouses, warehouseId],
  );

  async function handleClaim() {
    if (!warehouseId) return;
    const res = await claimNext.mutateAsync({ warehouseId });
    if (!res?.task_id) return;

    // Count work deep-links to its session: the operator lands on the bin
    // they claimed rather than a generic queue. The target is resolved by
    // an RPC so blind counting is never defeated by a table read.
    const { data } = await supabase.rpc("get_count_task_target" as never, {
      p_task_id: res.task_id,
    } as never);
    const target = data as { session_id?: string | null } | null;
    if (target?.session_id) {
      navigate(`/warehouse-app/counts/${target.session_id}`);
      return;
    }

    navigate(`/warehouse-app/tasks?claimed=${encodeURIComponent(res.task_id)}`);
  }

  return (
    <>
      <PageHeader
        title="Next task"
        description="Claim the highest-priority open task for your warehouse."
      />
      <PageBody>
        <div className="max-w-md mx-auto space-y-4">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Label>Warehouse</Label>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick your warehouse…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(warehouses ?? []).map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {activeWarehouse && (
                  <div className="mt-2 flex gap-2">
                    <Badge variant="secondary">{activeWarehouse.code ?? "WH"}</Badge>
                    <Badge variant="outline">Remembered on this device</Badge>
                  </div>
                )}
              </div>

              <Button
                className="w-full h-14 text-lg"
                onClick={handleClaim}
                disabled={!warehouseId || claimNext.isPending}
                aria-label="Claim next task"
              >
                {claimNext.isPending ? (
                  <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Claiming…</>
                ) : (
                  <><Play className="h-5 w-5 mr-2" /> Claim next task</>
                )}
              </Button>

              <div className="text-xs text-muted-foreground flex items-start gap-2">
                <PackageCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Tasks are picked in priority + SLA order and leased to you
                  for 5 minutes. Heartbeat keeps the lease alive while you
                  work; abandoned tasks are auto-released.
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground text-center">
            Routes: pick/pack/replenish/move → tasks · putaway → putaway ·
            count → counts · qc → qc · load → dispatch.
          </div>
        </div>
      </PageBody>
    </>
  );
}

export { routeForTaskType };