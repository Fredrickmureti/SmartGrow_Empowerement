import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { normalizeError } from "@/services/resilience";

export function AdminMfaStatus() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "enrolled" | "not_enrolled">("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);

  useEffect(() => {
    checkMfa();
  }, []);

  const checkMfa = async () => {
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp?.find(f => f.status === "verified");
      if (verified) {
        setFactorId(verified.id);
        setStatus("enrolled");
      } else {
        setStatus("not_enrolled");
      }
    } catch {
      setStatus("not_enrolled");
    }
  };

  const handleDisable = async () => {
    if (!factorId) return;
    setIsDisabling(true);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      toast.success("2FA disabled successfully");
      setStatus("not_enrolled");
      setFactorId(null);
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to disable 2FA");
    } finally {
      setIsDisabling(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="text-xs">Checking MFA status...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5 min-w-0">
        <Label className="text-xs sm:text-sm">Two-Factor Authentication</Label>
        <p className="text-[11px] sm:text-sm text-muted-foreground">
          {status === "enrolled"
            ? "TOTP authenticator is active on your account"
            : "Protect your admin account with an authenticator app"}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status === "enrolled" ? (
          <>
            <Badge variant="default" className="text-[10px] sm:text-xs gap-1">
              <ShieldCheck className="h-3 w-3" />
              Enabled
            </Badge>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-xs h-7">
                  Disable
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disable Two-Factor Authentication?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove TOTP protection from your admin account. You will be required to re-enroll before accessing the admin dashboard again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisable} disabled={isDisabling}>
                    {isDisabling ? "Disabling..." : "Disable 2FA"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <Badge variant="outline" className="text-[10px] sm:text-xs gap-1 text-destructive border-destructive/30">
              <ShieldOff className="h-3 w-3" />
              Not Set Up
            </Badge>
            <Button
              size="sm"
              className="text-xs h-7"
              onClick={() => navigate("/admin-management/mfa-setup")}
            >
              Set Up
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
