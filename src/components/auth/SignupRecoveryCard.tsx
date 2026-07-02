import { normalizeError } from "@/services/resilience";
/**
 * SignupRecoveryCard
 *
 * Replaces the dead-end "Setup Error" screen the user used to see when
 * their signup got into an inconsistent state. Gives three real options
 * instead of a wall.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, RotateCw, RefreshCw, UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { clearLocalAuthState } from "@/lib/auth/clearAuthState";

interface SignupRecoveryCardProps {
  /** Human-readable explanation of what went wrong. */
  message: string;
  /** Email of the currently signed-in user, if known — pre-fills the signup page. */
  email?: string | null;
}

export function SignupRecoveryCard({ message, email }: SignupRecoveryCardProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState<null | "retry" | "reset" | "switch">(null);

  const handleRetry = () => {
    setBusy("retry");
    // A clean reload re-runs OnboardingSetup with the same idempotency key.
    window.location.reload();
  };

  const handleResetMySignup = async () => {
    setBusy("reset");
    try {
      const { data: resetData, error } = await supabase.rpc("reset_my_signup");
      if (error) throw error;

      // If after the reset the identity is fully orphan (no remaining
      // tenancy, no platform role), free up the email by deleting the
      // auth.users row too. Without this the user can't re-signup with
      // the same email — the platform_admin-deleted-my-workspace bug.
      if ((resetData as { should_reap_identity?: boolean } | null)?.should_reap_identity) {
        try {
          const { data: reapData, error: reapErr } = await supabase.functions.invoke(
            "self-reap-orphan-identity",
            { body: {} },
          );
          if (reapErr) {
            console.warn("[SignupRecoveryCard] self-reap failed:", reapErr.message);
          } else if ((reapData as { reaped?: boolean } | null)?.reaped) {
            await clearLocalAuthState();
            toast({
              title: "Account reset",
              description: "Your email is now free — sign up fresh below.",
            });
            window.location.replace("/signup");
            return;
          }
        } catch (e) {
          console.warn("[SignupRecoveryCard] self-reap threw:", e);
        }
      }

      toast({
        title: "Signup reset",
        description: "We cleaned up your previous attempt. Let's try again.",
      });
      navigate("/signup", { replace: true });
    } catch (e: any) {
      toast({
        title: "Couldn't reset signup",
        description: normalizeError(e).message ?? "Please try the 'Use a different email' option below.",
        variant: "destructive",
      });
      setBusy(null);
    }
  };

  const handleSwitchAccount = async () => {
    setBusy("switch");
    try {
      await clearLocalAuthState();
      toast({
        title: "Session cleared",
        description: "You can now sign up or log in with a different email.",
      });
      // Hard-reload on /signup so React state and Supabase client reinitialise
      // from a clean slate (no stale in-memory tokens).
      window.location.replace("/signup");
    } catch (e: any) {
      toast({
        title: "Couldn't clear session",
        description: normalizeError(e).message ?? "Try opening a private window as a fallback.",
        variant: "destructive",
      });
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <CardTitle>We couldn't finish setting up your account</CardTitle>
          <CardDescription>{message}</CardDescription>
          {email && (
            <p className="text-xs text-muted-foreground mt-2">
              Signed in as <span className="font-medium">{email}</span>
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={handleRetry}
            disabled={busy !== null}
            className="w-full"
            variant="default"
          >
            {busy === "retry" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4 mr-2" />
            )}
            Retry setup
          </Button>

          <Button
            onClick={handleResetMySignup}
            disabled={busy !== null}
            className="w-full"
            variant="outline"
          >
            {busy === "reset" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Start over with this email
          </Button>

          <Separator className="my-2" />

          <Button
            onClick={handleSwitchAccount}
            disabled={busy !== null}
            className="w-full"
            variant="ghost"
          >
            {busy === "switch" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4 mr-2" />
            )}
            Use a different email
          </Button>

          <p className="text-xs text-muted-foreground text-center pt-2">
            Still stuck? Email{" "}
            <a href="mailto:support@accrualflow.com" className="underline">
              support@accrualflow.com
            </a>
            {" "}with the time of this error.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
