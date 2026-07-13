import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformAdmin } from "@/hooks/usePlatformTeam";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Crown, AlertTriangle, Loader2, X, CheckCircle } from "lucide-react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface PendingTransfer {
  id: string;
  to_user_id: string;
  status: string;
  expires_at: string;
  initiated_at: string;
  to_email?: string;
  to_name?: string;
}

interface OwnershipTransferDialogProps {
  admins: PlatformAdmin[];
  onComplete: () => void;
}

export function OwnershipTransferDialog({ admins, onComplete }: OwnershipTransferDialogProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState<PendingTransfer | null>(null);
  const [isLoadingTransfer, setIsLoadingTransfer] = useState(false);

  const eligibleAdmins = admins.filter(a => a.is_active && a.role !== "owner" && a.user_id !== user?.id);

  useEffect(() => {
    if (open) fetchPendingTransfer();
  }, [open]);

  const fetchPendingTransfer = async () => {
    setIsLoadingTransfer(true);
    try {
      const { data } = await supabase
        .from("platform_ownership_transfers")
        .select("*")
        .in("status", ["pending", "verified"])
        .order("initiated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        const target = admins.find(a => a.user_id === data.to_user_id);
        setPendingTransfer({
          ...data,
          to_email: target?.email,
          to_name: target?.full_name,
        });
      } else {
        setPendingTransfer(null);
      }
    } catch (err) {
      console.error("Error fetching pending transfer:", err);
    } finally {
      setIsLoadingTransfer(false);
    }
  };

  const handleInitiate = async () => {
    if (!targetUserId) return;
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("initiate_ownership_transfer", {
        _to_user_id: targetUserId,
        _notes: notes || null,
      });

      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        toast.error(result?.error || "Failed to initiate transfer");
        return;
      }

      toast.success("Ownership transfer initiated. The target admin must accept it.");
      setTargetUserId("");
      setNotes("");
      fetchPendingTransfer();
      onComplete();
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to initiate transfer");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!pendingTransfer) return;
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("cancel_ownership_transfer", {
        _transfer_id: pendingTransfer.id,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        toast.error(result?.error || "Failed to cancel transfer");
        return;
      }
      toast.success("Transfer cancelled");
      setPendingTransfer(null);
      onComplete();
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to cancel");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Crown className="h-3.5 w-3.5" />
          Transfer Ownership
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-amber-500" />
            Platform Ownership Transfer
          </AlertDialogTitle>
          <AlertDialogDescription>
            Transfer platform ownership to another active admin. This action is reversible until the target accepts.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoadingTransfer ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : pendingTransfer ? (
          <div className="space-y-4">
            <div className="border rounded-lg p-4 bg-amber-500/5 border-amber-200">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Transfer Pending</p>
                  <p className="text-xs text-muted-foreground">
                    Awaiting acceptance from{" "}
                    <span className="font-medium">{pendingTransfer.to_name || pendingTransfer.to_email}</span>
                  </p>
                  <div className="flex gap-2 mt-2">
                    <Badge variant="outline" className="text-[10px]">
                      Status: {pendingTransfer.status}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      Expires: {format(new Date(pendingTransfer.expires_at), "MMM d, yyyy HH:mm")}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
            <AlertDialogFooter>
              <Button variant="destructive" size="sm" onClick={handleCancel} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                <X className="h-3.5 w-3.5 mr-1.5" />
                Cancel Transfer
              </Button>
            </AlertDialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="border rounded-lg p-3 bg-destructive/5 border-destructive/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
                <p className="text-xs text-destructive">
                  After transfer, your role will be downgraded to Admin. The new owner will have full platform control.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Transfer to</Label>
              <Select value={targetUserId} onValueChange={setTargetUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an admin..." />
                </SelectTrigger>
                <SelectContent>
                  {eligibleAdmins.map(admin => (
                    <SelectItem key={admin.user_id} value={admin.user_id}>
                      <div className="flex items-center gap-2">
                        <span>{admin.full_name || admin.email}</span>
                        <Badge variant="outline" className="text-[10px]">{admin.role}</Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eligibleAdmins.length === 0 && (
                <p className="text-xs text-muted-foreground">No eligible admins. Invite and activate an admin first.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Input
                placeholder="Reason for transfer..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleInitiate} disabled={!targetUserId || isSubmitting}>
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Initiate Transfer
              </Button>
            </AlertDialogFooter>
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Small component for the target user to accept a pending transfer */
export function AcceptOwnershipBanner({ onAccepted }: { onAccepted: () => void }) {
  const { user } = useAuth();
  const [transfer, setTransfer] = useState<any>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data } = await supabase
        .from("platform_ownership_transfers")
        .select("*")
        .eq("to_user_id", user.id)
        .in("status", ["pending", "verified"])
        .order("initiated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setTransfer(data);
    };
    load();
  }, [user]);

  if (!transfer) return null;

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const { data, error } = await supabase.rpc("complete_ownership_transfer", {
        _transfer_id: transfer.id,
        _verification_token: transfer.verification_token,
      });
      if (error) throw error;
      const result = data as any;
      if (!result?.success) {
        toast.error(result?.error || "Failed to accept transfer");
        return;
      }
      toast.success("You are now the platform owner!");
      setTransfer(null);
      onAccepted();
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to accept");
    } finally {
      setIsAccepting(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 bg-amber-500/10 border-amber-300 mb-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Crown className="h-5 w-5 text-amber-600" />
          <div>
            <p className="text-sm font-medium">Ownership Transfer Pending</p>
            <p className="text-xs text-muted-foreground">
              The platform owner wants to transfer ownership to you.
              Expires {format(new Date(transfer.expires_at), "MMM d, yyyy")}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={handleAccept} disabled={isAccepting}>
          {isAccepting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5 mr-1.5" />}
          Accept
        </Button>
      </div>
    </div>
  );
}
