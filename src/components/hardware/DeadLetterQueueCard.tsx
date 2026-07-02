/**
 * DeadLetterQueueCard — Wave 11 R2.
 *
 * Operator-visible surface for `hw_command_queue` rows that exhausted their
 * retry budget (status='dead'). Without this card those rows were written
 * to SQLite by `CommandQueue.tick()` but never displayed anywhere, so
 * cashiers only discovered missed prints when a customer complained.
 *
 * Reads via the `pos:queue:list-dead` IPC channel added in this wave.
 * Replay re-queues the row with attempts=0; Discard moves it to terminal
 * `failed` status so it leaves the active dead list but stays in the
 * audit trail.
 *
 * Drop this card into `src/apps/platform/hardware/HardwareDiagnostics.tsx`
 * — it is intentionally self-contained so it can be added in a follow-up
 * PR without touching the rest of that 700-line file.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type QueueRow = {
  id: number;
  device_role: string;
  op: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  idempotency_key: string;
  updated_at: number;
};

type QueueBridge = {
  listDead?: () => Promise<{ ok: boolean; rows?: QueueRow[]; error?: string }>;
  replayDead?: (id: number) => Promise<{ ok: boolean; error?: string }>;
  discardDead?: (id: number) => Promise<{ ok: boolean; error?: string }>;
};

function getBridge(): QueueBridge | null {
  if (typeof window === "undefined") return null;
  const pos = (window as unknown as { pos?: { queue?: QueueBridge } }).pos;
  return pos?.queue ?? null;
}

export function DeadLetterQueueCard() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const bridge = getBridge();

  const refresh = useCallback(async () => {
    if (!bridge?.listDead) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const res = await bridge.listDead();
      setRows(res.ok ? (res.rows ?? []) : []);
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const handleReplay = async (id: number) => {
    if (!bridge?.replayDead) return;
    const res = await bridge.replayDead(id);
    if (res.ok) {
      toast.success(`Re-queued command #${id}`);
      void refresh();
    } else {
      toast.error(res.error ?? "Replay failed");
    }
  };

  const handleDiscard = async (id: number) => {
    if (!bridge?.discardDead) return;
    const res = await bridge.discardDead(id);
    if (res.ok) {
      toast.success(`Discarded command #${id}`);
      void refresh();
    } else {
      toast.error(res.error ?? "Discard failed");
    }
  };

  if (!bridge) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Failed prints</CardTitle>
          <CardDescription>Requires the Electron runtime.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Failed prints (dead-letter queue)</CardTitle>
          <CardDescription>
            Commands that exhausted their retry budget. Replay re-runs the command; Discard files it as audit-only.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">No failed commands. 🎉</p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 rounded border p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">{r.device_role}</Badge>
                  <span className="font-mono text-xs">{r.op}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.attempts}/{r.max_attempts} attempts
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {r.last_error ?? "No error message"}
                </p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground">
                  key: {r.idempotency_key}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="default" onClick={() => void handleReplay(r.id)}>
                  Replay
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleDiscard(r.id)}>
                  Discard
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default DeadLetterQueueCard;
