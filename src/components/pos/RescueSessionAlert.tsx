import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, ShieldAlert, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { ManagerOverrideDialog } from "@/components/pos/ManagerOverrideDialog";
import { useManagerOverride } from "@/hooks/pos/useManagerOverride";
import { humanizePosError } from "@/lib/pos/humanizePosError";
import { ScopeOwnershipBadge } from "@/components/pos/ScopeOwnershipBadge";
import { normalizeError } from "@/services/resilience";

/**
 * Stage 8: orphaned-shift recovery now goes through `force_close_pos_shift`
 * (SECURITY DEFINER RPC + manager PIN + `assert_manager_override` + audit log).
 * The DB trigger `trg_pos_shifts_no_client_status_flip` blocks any client
 * `.update({status:'closed'})` so this is the only way to rescue a shift.
 *
 * Stage R4 hardening:
 *  - Visibility is gated by `usePOSOverseer().canOversee`. Branch-scoped
 *    operators never see (or can rescue) foreign-branch orphaned shifts.
 *  - Each row carries a `ScopeOwnershipBadge` so overseers can see at a
 *    glance which branch a shift belongs to before approving a force-close.
 *  - Confirmation dialog echoes the owning branch name.
 */
export function RescueSessionAlert() {
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const queryClient = useQueryClient();
  const [rescueShift, setRescueShift] = useState<any>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [actualCash, setActualCash] = useState<string>("0");

  const { requestOverride, isVerifying } = useManagerOverride({
    businessId: rescueShift?.business_id,
  });

  const activeBranchId = currentBranch?.id ?? null;

  const { data: orphanedShifts = [] } = useQuery({
    queryKey: ["pos-orphaned-shifts", currentOrg?.id, activeBranchId, canOversee],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);
      let q = supabase
        // SCOPE-EXEMPT: overseer-only rescue tooling. Non-overseers are
        // blocked by `enabled`. When a branch is active we still scope to
        // it so a branch-context overseer sees only their branch's shifts.
        .from("pos_shifts")
        .select(`*, register:pos_registers(id, register_name, register_code), branch:branches(id, name)`)
        .eq("organization_id", currentOrg.id)
        .eq("status", "open")
        .lt("opened_at", cutoff.toISOString());
      if (activeBranchId) {
        q = q.eq("branch_id", activeBranchId);
      }
      const { data, error } = await q.order("opened_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id && canOversee,
    refetchInterval: 5 * 60 * 1000,
  });

  const rescueMutation = useMutation({
    mutationFn: async (vars: { shiftId: string; overrideId: string; reason: string; actualCash: number }) => {
      const { data, error } = await supabase.rpc("force_close_pos_shift" as any, {
        p_shift_id: vars.shiftId,
        p_reason: vars.reason,
        p_override_id: vars.overrideId,
        p_actual_cash: vars.actualCash,
      } as any);
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any, vars) => {
      queryClient.invalidateQueries({ queryKey: ["pos-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-user-current-shift"] });
      queryClient.invalidateQueries({ queryKey: ["pos-orphaned-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["pos-registers"] });
      const label =
        data?.shift_number && data?.register_name
          ? `${data.shift_number} on ${data.register_name}`
          : rescueShift?.shift_number || "shift";
      setRescueShift(null);
      setReason("");
      setActualCash("0");
      toast.success(`Force-closed ${label} (audited)`);
    },
    onError: (error: Error) => {
      const label = rescueShift
        ? `${rescueShift.shift_number} on ${rescueShift.register?.register_name || "Unknown register"}`
        : "shift";
      toast.error(`Couldn't force-close ${label}: ${humanizePosError(normalizeError(error).message)}`);
    },
  });

  const handleApprove = async (pin: string, approverReason?: string) => {
    if (!rescueShift) return;
    if (!reason.trim()) {
      toast.error("A reason is required for a force-close");
      return;
    }
    try {
      const result = await requestOverride({
        action: "force_close_shift",
        pin,
        registerId: rescueShift.register_id,
        shiftId: rescueShift.id,
        reason: approverReason || reason,
      });
      setPinOpen(false);
      await rescueMutation.mutateAsync({
        shiftId: rescueShift.id,
        overrideId: result.overrideId,
        reason,
        actualCash: parseFloat(actualCash) || 0,
      });
    } catch {
      // toast already raised by useManagerOverride / mutation
    }
  };

  if (orphanedShifts.length === 0) return null;

  return (
    <>
      <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle className="text-sm font-semibold">
          Orphaned Shifts Detected ({orphanedShifts.length})
        </AlertTitle>
        <AlertDescription className="text-xs mt-1 space-y-2">
          <p className="text-muted-foreground">
            These shifts have been open for more than 24 hours and may be from crashed sessions or forgotten closes.
          </p>
          <div className="space-y-1.5">
            {orphanedShifts.map((shift: any) => (
              <div key={shift.id} className="flex items-center justify-between p-2 rounded-md bg-background border text-foreground">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <span className="text-xs font-medium truncate block">
                      {shift.shift_number} — {shift.register?.register_name || "Unknown Register"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Open {formatDistanceToNow(new Date(shift.opened_at), { addSuffix: true })}
                    </span>
                    <ScopeOwnershipBadge
                      ownerBranchId={shift.branch_id ?? null}
                      ownerBranchName={shift.branch?.name ?? null}
                      activeBranchId={activeBranchId}
                      className="mt-1"
                    />
                  </div>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs flex-shrink-0 ml-2" onClick={() => setRescueShift(shift)}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Rescue
                </Button>
              </div>
            ))}
          </div>
        </AlertDescription>
      </Alert>

      <Dialog open={!!rescueShift && !pinOpen} onOpenChange={(open) => !open && setRescueShift(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Force-Close Orphaned Shift
            </DialogTitle>
            <DialogDescription>
              Audited action. Requires a manager PIN. The shift will be closed at the supplied actual
              cash amount; the GL entry will post automatically.
            </DialogDescription>
          </DialogHeader>

          {rescueShift && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Shift Number</p>
                  <p className="font-medium">{rescueShift.shift_number}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Register</p>
                  <p className="font-medium">{rescueShift.register?.register_name}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Branch</p>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{rescueShift.branch?.name ?? "—"}</p>
                    <ScopeOwnershipBadge
                      ownerBranchId={rescueShift.branch_id ?? null}
                      ownerBranchName={rescueShift.branch?.name ?? null}
                      activeBranchId={activeBranchId}
                    />
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Opened</p>
                  <p className="font-medium text-xs">{new Date(rescueShift.opened_at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Duration</p>
                  <Badge variant="destructive" className="text-xs">
                    {formatDistanceToNow(new Date(rescueShift.opened_at))}
                  </Badge>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rescue-reason" className="text-xs">Reason (required, audited)</Label>
                <Textarea
                  id="rescue-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. terminal crashed mid-shift, cashier left without closing"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rescue-actual" className="text-xs">Actual cash counted</Label>
                <input
                  id="rescue-actual"
                  type="number"
                  step="0.01"
                  min="0"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                />
              </div>
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Variance against expected cash will be recorded as Cash Over/Short and posted to the GL.
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRescueShift(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => setPinOpen(true)}
              disabled={!reason.trim() || rescueMutation.isPending}
            >
              {rescueMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Continue → Manager PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        action="force_close_shift"
        onApprove={handleApprove}
        isVerifying={isVerifying || rescueMutation.isPending}
      />
    </>
  );
}
