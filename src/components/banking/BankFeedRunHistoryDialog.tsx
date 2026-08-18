import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useBankFeedRuns } from "@/hooks/useBankFeedRuns";

interface BankFeedRunHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bankAccountId: string;
  accountName: string;
}

function statusVariant(status: string) {
  if (status === "succeeded") return "text-green-600 border-green-500";
  if (status === "partial") return "text-amber-600 border-amber-500";
  if (status === "failed") return "text-destructive border-destructive/50";
  return "text-muted-foreground";
}

function formatWhen(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatWindow(from: string | null, to: string | null) {
  if (!from && !to) return "—";
  return `${from ?? "…"} → ${to ?? "…"}`;
}

/**
 * Phase 18.3 — read-only feed run history. Every number here traces back to a
 * `bank_feed_runs` row written by the run seam; nothing on this screen can
 * start, alter or reinterpret a run.
 */
export function BankFeedRunHistoryDialog({
  open,
  onOpenChange,
  bankAccountId,
  accountName,
}: BankFeedRunHistoryDialogProps) {
  const { data: runs, isLoading, error } = useBankFeedRuns(open ? bankAccountId : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sync history — {accountName}</DialogTitle>
          <DialogDescription>
            Each row is one feed run: the window requested from the bank and what the
            import engine accepted.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Loading runs…
          </div>
        )}

        {error && (
          <p className="py-6 text-sm text-destructive">Could not load the sync history.</p>
        )}

        {!isLoading && !error && (runs?.length ?? 0) === 0 && (
          <p className="py-6 text-sm text-muted-foreground">
            No sync has run for this account yet.
          </p>
        )}

        {!isLoading && (runs?.length ?? 0) > 0 && (
          <div className="max-h-[60vh] overflow-y-auto divide-y">
            {runs!.map((run) => (
              <div key={run.id} className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={statusVariant(run.status)}>
                      {run.status}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {run.trigger_source ?? "manual"}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatWhen(run.started_at)}
                    {run.finished_at ? ` → ${formatWhen(run.finished_at)}` : ""}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground">
                  Window {formatWindow(run.window_from, run.window_to)}
                </p>

                <p className="text-xs">
                  <span className="text-muted-foreground">Fetched</span> {run.fetched_count ?? 0}
                  {" · "}
                  <span className="text-muted-foreground">Imported</span> {run.inserted_count ?? 0}
                  {" · "}
                  <span className="text-muted-foreground">Duplicates</span>{" "}
                  {run.duplicate_count ?? 0}
                  {" · "}
                  <span className="text-muted-foreground">Rejected</span> {run.rejected_count ?? 0}
                </p>

                {(run.error_code || run.error_message) && (
                  <p className="text-xs text-destructive">
                    {run.error_code ?? "Error"}
                    {run.error_message ? ` — ${run.error_message}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
