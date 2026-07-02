/**
 * AcceptOwnership page — reached via the verification link emailed to the
 * incoming workspace owner. Two clicks: verify token, then complete transfer.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Crown, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

type Phase = "loading" | "verifying" | "ready" | "completing" | "done" | "error";

export default function AcceptOwnership() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      // Bounce to login but preserve where to come back to.
      navigate(`/login?redirect=${encodeURIComponent(`/accept-ownership/${token}`)}`);
      return;
    }
    if (!token) {
      setError("Missing transfer token");
      setPhase("error");
      return;
    }

    (async () => {
      setPhase("verifying");
      try {
        const { data, error: rpcError } = await supabase.rpc(
          "verify_tenant_ownership_transfer" as never,
          { p_token: token } as never,
        );
        if (rpcError) throw rpcError;
        const payload = data as { id: string; organization_id: string } | null;
        if (!payload?.id) throw new Error("Invalid response from server");
        setTransferId(payload.id);
        setOrganizationId(payload.organization_id);
        setPhase("ready");
      } catch (e: any) {
        setError(e?.message ?? "Failed to verify transfer link");
        setPhase("error");
      }
    })();
  }, [authLoading, user, token, navigate]);

  const handleComplete = async () => {
    if (!transferId) return;
    setPhase("completing");
    try {
      const { error: rpcError } = await supabase.rpc(
        "complete_tenant_ownership_transfer" as never,
        { p_transfer_id: transferId } as never,
      );
      if (rpcError) throw rpcError;
      toast.success("You are now the workspace owner");
      setPhase("done");
      setTimeout(() => navigate("/dashboard"), 1500);
    } catch (e: any) {
      setError(e?.message ?? "Failed to complete transfer");
      setPhase("error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            <Crown className="h-6 w-6 text-amber-500" />
          </div>
          <CardTitle>Accept workspace ownership</CardTitle>
          <CardDescription>
            The current owner has invited you to take over this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(phase === "loading" || phase === "verifying") && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Verifying invitation…
            </div>
          )}

          {phase === "ready" && (
            <>
              <div className="rounded-md border p-3 text-sm">
                Workspace: <span className="font-mono text-xs">{organizationId}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Once you accept, you become the owner. The previous owner keeps
                their account and other roles, but loses the owner privilege.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => navigate("/dashboard")} className="flex-1">
                  Not now
                </Button>
                <Button onClick={handleComplete} className="flex-1">
                  Accept ownership
                </Button>
              </div>
            </>
          )}

          {phase === "completing" && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Finalizing transfer…
            </div>
          )}

          {phase === "done" && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle className="h-10 w-10 text-green-500" />
              <p className="font-medium">You are now the owner</p>
              <p className="text-xs text-muted-foreground">Redirecting…</p>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
              <Button variant="outline" onClick={() => navigate("/dashboard")} className="w-full">
                Back to dashboard
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
