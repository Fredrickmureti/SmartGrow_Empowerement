/**
 * Warehouse mobile — top-bar queue indicator (Phase 13).
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CloudOff, AlertTriangle, RotateCw, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { discard, pending, retry, subscribe, type QueuedCall } from "./offlineQueue";

export function QueueIndicator() {
  const [rows, setRows] = useState<QueuedCall[]>([]);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const r = await pending();
      if (alive) setRows(r);
    };
    const unsub = subscribe(refresh);
    refresh();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      alive = false;
      unsub();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const errored = rows.filter((r) => r.last_error);
  const tone: "ok" | "queued" | "err" = errored.length
    ? "err"
    : rows.length
      ? "queued"
      : "ok";
  const cls =
    tone === "err"
      ? "bg-destructive/15 text-destructive"
      : tone === "queued"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  const Icon = tone === "err" ? AlertTriangle : !online ? CloudOff : CheckCircle2;
  const label =
    tone === "err"
      ? `${errored.length} err`
      : rows.length
        ? `${rows.length} queued`
        : online
          ? "synced"
          : "offline";

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${cls}`}
          aria-label="Queue status"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[70vh]">
        <SheetHeader>
          <SheetTitle>Offline queue</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-2 overflow-y-auto pb-4">
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing pending. All actions are synced.
            </p>
          )}
          {rows.map((r) => (
            <div key={r.id} className="rounded border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-medium">{r.rpc}</div>
                  <div className="text-muted-foreground truncate">
                    {JSON.stringify(r.args)}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {new Date(r.enqueued_at).toLocaleTimeString()} · attempts {r.attempts}
                    {r.last_error ? ` · ${r.last_error}` : ""}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => r.id != null && retry(r.id)}
                    className="h-7 px-2"
                  >
                    <RotateCw className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => r.id != null && discard(r.id)}
                    className="h-7 px-2"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
