import { normalizeError } from "@/services/resilience";
/**
 * Stage 8.5: ReopenShiftDialog
 *
 * Closed-shift reopen surface. Backed by `reopen_pos_shift` (SECURITY DEFINER).
 * Reopen is allowed only inside the 72h window enforced server-side; the UI
 * disables the action outside that window for fast feedback. Manager PIN is
 * always required (matrix action `reopen_shift`, restricted to owner/admin/
 * super_admin). On success, the original close JE is reversed via the
 * existing `void_journal_entry_atomic` helper.
 *
 * The dialog is intentionally thin — every safety check (auth, role, window,
 * single-use override consumption, JE reversal, audit log) lives in the RPC.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { ManagerOverrideDialog } from "@/components/pos/ManagerOverrideDialog";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { differenceInHours, formatDistanceToNow } from "date-fns";

interface ReopenShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: {
    id: string;
    shift_number: string;
    business_id: string;
    register_id: string;
    closed_at: string | null;
    register?: { register_name?: string } | null;
  } | null;
}

export function ReopenShiftDialog({ open, onOpenChange, shift }: ReopenShiftDialogProps) {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [pinOpen, setPinOpen] = useState(false);

  const { requestOverride, isVerifying } = useManagerOverride(
    currentOrg?.id,
    shift?.business_id
  );

  const closedAt = shift?.closed_at ? new Date(shift.closed_at) : null;
  const hoursSinceClose = closedAt ? differenceInHours(new Date(), closedAt) : null;
  const outsideWindow = hoursSinceClose !== null && hoursSinceClose >= 72;
  const reasonValid = reason.trim().length >= 10;

  const reopenMutation = useMutation({
    mutationFn: async (vars: { shiftId: string; reason: string; overrideId: string }) => {
      const { data, error } = await supabase.rpc("reopen_pos_shift" as any, {
        p_shift_id: vars.shiftId,
        p_reason: vars.reason,
        p_override_id: vars.overrideId,
      } as any);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-shift-integrity"] });
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Shift reopened — close JE reversed");
      setReason("");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(`Failed to reopen shift: ${normalizeError(err).message}`);
    },
  });

  const handleApprove = async (pin: string, approverReason?: string) => {
    if (!shift || !reasonValid) return;
    try {
      const result = await requestOverride({
        action: "reopen_shift",
        pin,
        registerId: shift.register_id,
        shiftId: shift.id,
        reason: approverReason || reason,
      });
      setPinOpen(false);
      await reopenMutation.mutateAsync({
        shiftId: shift.id,
        reason,
        overrideId: result.overrideId,
      });
    } catch {
      // toast handled by hooks
    }
  };

  return (
    <>
      <Dialog open={open && !pinOpen} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              Reopen Shift
            </DialogTitle>
            <DialogDescription>
              Reverses the close journal entry and unlocks the shift. Audited and
              gated by the override matrix (admin-only).
            </DialogDescription>
          </DialogHeader>

          {shift && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Shift</p>
                  <p className="font-mono text-xs">{shift.shift_number}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Register</p>
                  <p className="font-medium">{shift.register?.register_name ?? "—"}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-muted-foreground text-xs">Closed</p>
                  <p className="text-xs">
                    {closedAt
                      ? `${closedAt.toLocaleString()} (${formatDistanceToNow(closedAt, { addSuffix: true })})`
                      : "—"}
                  </p>
                </div>
              </div>

              {outsideWindow && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle className="text-sm">Outside reopen window</AlertTitle>
                  <AlertDescription className="text-xs">
                    Shifts closed more than 72 hours ago cannot be reopened.
                    Post a manual adjusting entry instead.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="reopen-reason" className="text-xs">
                  Reason (required, audited; min 10 chars)
                </Label>
                <Textarea
                  id="reopen-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. cashier missed a tender; need to amend before EOD reconciliation"
                  disabled={outsideWindow}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => setPinOpen(true)}
              disabled={!reasonValid || outsideWindow || reopenMutation.isPending}
            >
              {reopenMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Continue → Manager PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        action="reopen_shift"
        onApprove={handleApprove}
        isVerifying={isVerifying || reopenMutation.isPending}
      />
    </>
  );
}
