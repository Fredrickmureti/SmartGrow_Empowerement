/**
 * OwnerRecoveryBanner — shown when the signed-in user owns the workspace
 * (organizations.owner_user_id = auth.uid()) but their active role in
 * session data is portal. That state is the symptom of the
 * "admin demoted via portal invitation" lockout we fixed. The banner
 * gives the owner a one-click recovery path that calls the
 * restore_owner_role() RPC.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { toast } from "sonner";

export function OwnerRecoveryBanner() {
  const { user } = useAuth();
  const { currentOrg, userRole, refreshSession } = useSession();
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id || !currentOrg?.id || userRole !== "portal") {
        setEligible(false);
        return;
      }
      const { data } = await supabase
        .from("organizations")
        .select("owner_user_id")
        .eq("id", currentOrg.id)
        .maybeSingle();
      if (!cancelled) setEligible(data?.owner_user_id === user.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, currentOrg?.id, userRole]);

  if (!eligible || !currentOrg) return null;

  const handleRestore = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("restore_owner_role" as any, {
        p_org_id: currentOrg.id,
      });
      if (error) throw error;
      toast.success("Owner access restored. Reloading…");
      await refreshSession();
      setTimeout(() => window.location.reload(), 400);
    } catch (err: any) {
      toast.error(err?.message ?? "Could not restore owner role.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert variant="destructive" className="m-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Your owner role looks overwritten</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          You still own this workspace, but your access has been reduced to a
          portal user. Click restore to reinstate your owner role.
        </span>
        <Button size="sm" onClick={handleRestore} disabled={busy}>
          <ShieldCheck className="h-4 w-4 mr-2" />
          {busy ? "Restoring…" : "Restore owner access"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export default OwnerRecoveryBanner;
