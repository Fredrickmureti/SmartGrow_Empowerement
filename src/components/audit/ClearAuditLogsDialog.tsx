import { normalizeError } from "@/services/resilience";
/**
 * ClearAuditLogsDialog — confirmation dialog for purging audit log entries.
 *
 * Calls the supplied `onConfirm` with the chosen retention window
 * (in days, or `null` for "delete everything").
 */
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  /** Returns number of rows deleted. */
  onConfirm: (olderThanDays: number | null) => Promise<number>;
  /** Optional friendly scope, e.g. "platform" or "this organization". */
  scopeLabel?: string;
  triggerLabel?: string;
}

export function ClearAuditLogsDialog({
  onConfirm,
  scopeLabel = "these",
  triggerLabel = "Clear logs",
}: Props) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<"30" | "90" | "365" | "all">("90");
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const days = choice === "all" ? null : parseInt(choice, 10);
      const deleted = await onConfirm(days);
      toast.success(
        deleted > 0
          ? `Cleared ${deleted.toLocaleString()} audit ${deleted === 1 ? "entry" : "entries"}`
          : "No matching entries to clear",
      );
      setOpen(false);
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to clear audit logs");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="mr-2 h-4 w-4" />
        {triggerLabel}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear audit logs</AlertDialogTitle>
            <AlertDialogDescription>
              Choose how much history to keep for {scopeLabel} audit log. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v as typeof choice)} className="space-y-2">
            {[
              { v: "30", l: "Keep last 30 days (delete older)" },
              { v: "90", l: "Keep last 90 days (delete older)" },
              { v: "365", l: "Keep last 1 year (delete older)" },
              { v: "all", l: "Delete ALL audit log entries" },
            ].map((opt) => (
              <Label
                key={opt.v}
                htmlFor={`clear-${opt.v}`}
                className="flex items-center gap-2 rounded-md border p-2 cursor-pointer hover:bg-accent"
              >
                <RadioGroupItem value={opt.v} id={`clear-${opt.v}`} />
                <span className={opt.v === "all" ? "text-destructive font-medium" : ""}>{opt.l}</span>
              </Label>
            ))}
          </RadioGroup>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={busy}
              className={choice === "all" ? "bg-destructive hover:bg-destructive/90" : ""}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {choice === "all" ? "Delete everything" : "Delete older entries"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
