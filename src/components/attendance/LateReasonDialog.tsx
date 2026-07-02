/**
 * LateReasonDialog — non-blocking prompt shown after a successful clock-in
 * when the resulting attendance row indicates the employee arrived past
 * the configured grace period.
 *
 * Captures a one-line reason and posts it to attendance.late_reason
 * directly (RLS allows the owner to update their own row). The dialog is
 * dismissible without a reason — capturing it is a courtesy, not a
 * blocker, and *avoids* the heavier correction-request flow for trivial
 * lateness.
 *
 * Pass 5 — Attendance: presentation migrated to `WorkflowSheet`. The
 * supabase mutation, suggestions, and dismissibility are unchanged.
 */
import { useEffect, useState } from "react";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  attendanceId: string | null;
  lateMinutes: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SUGGESTIONS = [
  "Heavy traffic",
  "Public transport delay",
  "Personal emergency",
  "Medical appointment",
];

export function LateReasonDialog({ attendanceId, lateMinutes, open, onOpenChange }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const submit = async () => {
    if (!attendanceId || !reason.trim()) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase
        .from("attendance")
        .update({ late_reason: reason.trim().slice(0, 500) } as any)
        .eq("id", attendanceId);
      if (error) throw error;
      toast.success("Reason recorded");
      qc.invalidateQueries({ queryKey: ["my-attendance"] });
      qc.invalidateQueries({ queryKey: ["attendance"] });
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save reason");
    } finally {
      setBusy(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          You're {lateMinutes ?? 0} min late
        </span>
      }
      description="Add a short reason so your manager has context. Optional — you can skip this and continue."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Skip
          </Button>
          <Button onClick={submit} disabled={busy || !reason.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Save reason
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Reason">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setReason(s)}
                className="h-7 text-xs"
              >
                {s}
              </Button>
            ))}
          </div>
          <WorkflowField label="Details" htmlFor="late-reason-input">
            <Textarea
              id="late-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. accident on the highway"
              rows={3}
              maxLength={500}
            />
          </WorkflowField>
        </div>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
