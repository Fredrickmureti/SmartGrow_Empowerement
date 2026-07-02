import { normalizeError } from "@/services/resilience";
/**
 * TenantOwnershipTransferDialog
 *
 * Tenant-level mirror of the platform OwnershipTransferDialog. Lets the
 * current workspace owner hand the org over to another active member via
 * the 2-step verified flow backed by `tenant_ownership_transfers` and the
 * `initiate_tenant_ownership_transfer` / `verify_tenant_ownership_transfer`
 * / `complete_tenant_ownership_transfer` RPCs.
 *
 * Why a dialog (and not silent transfer):
 *   - Ownership change is destructive (ex-owner loses owner role).
 *   - Requires an out-of-band confirmation by the new owner (email link).
 *   - Mirrors how Xero / Odoo / Stripe handle this.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Crown, AlertTriangle, Loader2, X, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

interface EligibleMember {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

interface PendingTransfer {
  id: string;
  to_user_id: string;
  status: string;
  expires_at: string;
  initiated_at: string;
  to_email?: string | null;
  to_name?: string | null;
}

interface Props {
  members: EligibleMember[];
  onComplete: () => void;
}

export function TenantOwnershipTransferDialog({ members, onComplete }: Props) {
  const { user } = useAuth();
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [isLoadingPending, setIsLoadingPending] = useState(false);

  const eligible = members.filter(
    (m) => m.user_id !== user?.id && m.role !== "owner",
  );

  const fetchPending = async () => {
    if (!currentOrg?.id) return;
    setIsLoadingPending(true);
    try {
      const { data, error } = await supabase
        .from("tenant_ownership_transfers")
        .select("id, to_user_id, status, expires_at, initiated_at")
        .eq("organization_id", currentOrg.id)
        .in("status", ["pending", "verified"])
        .order("initiated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        const target = members.find((m) => m.user_id === data.to_user_id);
        setPending({
          ...data,
          to_email: target?.email ?? null,
          to_name: target?.full_name ?? null,
        });
      } else {
        setPending(null);
      }
    } catch (e: any) {
      console.warn("[TenantOwnership] fetch pending failed:", e?.message);
    } finally {
      setIsLoadingPending(false);
    }
  };

  useEffect(() => {
    if (open) fetchPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentOrg?.id]);

  const handleInitiate = async () => {
    if (!targetUserId || !currentOrg?.id) return;
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.rpc(
        "initiate_tenant_ownership_transfer" as never,
        {
          p_organization_id: currentOrg.id,
          p_to_user_id: targetUserId,
          p_notes: notes.trim() || null,
        } as never,
      );
      if (error) throw error;

      // Send the verification email with the token (best-effort).
      const token = (data as any)?.token;
      const target = members.find((m) => m.user_id === targetUserId);
      if (token && target?.email) {
        try {
          await supabase.functions.invoke("send-tenant-ownership-transfer", {
            body: {
              organizationId: currentOrg.id,
              organizationName: currentOrg.name,
              toEmail: target.email,
              toName: target.full_name ?? target.email,
              fromName: user?.user_metadata?.full_name ?? user?.email,
              token,
              notes: notes.trim() || null,
            },
          });
        } catch (mailErr) {
          console.warn("[TenantOwnership] email send failed:", mailErr);
          toast.warning(
            "Transfer initiated, but the verification email couldn't be sent. Share this link manually.",
          );
        }
      }

      toast.success("Ownership transfer initiated. The new owner has been emailed.");
      setTargetUserId("");
      setNotes("");
      await fetchPending();
      onComplete();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to initiate transfer");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!pending) return;
    setIsSubmitting(true);
    try {
      const { error } = await supabase.rpc(
        "cancel_tenant_ownership_transfer" as never,
        { p_transfer_id: pending.id } as never,
      );
      if (error) throw error;
      toast.success("Transfer cancelled");
      await fetchPending();
      onComplete();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to cancel");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Crown className="h-4 w-4 mr-2" /> Transfer Ownership
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-amber-500" />
            Transfer workspace ownership
          </DialogTitle>
          <DialogDescription>
            Hand this workspace to another active member. They must confirm via
            an emailed link to complete the transfer.
          </DialogDescription>
        </DialogHeader>

        {isLoadingPending ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : pending ? (
          <div className="space-y-4">
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {pending.status === "verified" ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
                Pending transfer
                <Badge variant="outline" className="ml-auto capitalize">
                  {pending.status}
                </Badge>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">To: </span>
                {pending.to_name ?? pending.to_email ?? pending.to_user_id}
              </div>
              <div className="text-xs text-muted-foreground">
                Initiated {format(new Date(pending.initiated_at), "PPp")} · Expires{" "}
                {format(new Date(pending.expires_at), "PPp")}
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={handleCancel}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <X className="h-4 w-4 mr-2" />
                )}
                Cancel transfer
              </Button>
            </DialogFooter>
          </div>
        ) : eligible.length === 0 ? (
          <div className="rounded-md border p-4 text-sm text-muted-foreground">
            No eligible members. Invite another active member first.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>New owner</Label>
              <Select value={targetUserId} onValueChange={setTargetUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a member" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name ?? m.email ?? m.user_id}
                      {m.email && m.full_name ? ` · ${m.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Why are you transferring ownership?"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
              You will retain your current role but lose the owner privilege
              once they confirm. This action is logged.
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button onClick={handleInitiate} disabled={!targetUserId || isSubmitting}>
                {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Send transfer request
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
