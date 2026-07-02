/**
 * SignupRecoveryCardInline
 *
 * The same three-action recovery flow as <SignupRecoveryCard> but without
 * the full-screen Card chrome — designed to be embedded *under* the login
 * or signup form (audit v2 — C2). Reaches users who got stuck before they
 * ever made it to /onboarding-setup (the original mount point).
 *
 * Actions:
 *   1. Reset my signup     → calls reset_my_signup() RPC (only works while
 *                            still signed in to the half-broken account).
 *   2. Use a different email → fully clears Supabase local storage so the
 *                              same email or a fresh one can sign up cleanly.
 *
 * "Retry setup" is omitted here because /login and /signup are not the
 * setup screen; retrying would mean re-submitting the form, which the
 * user can already do.
 */
import { useState } from "react";
import { Loader2, RefreshCw, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { clearLocalAuthState } from "@/lib/auth/clearAuthState";

interface Props {
  /** If we know the email at the call site (login form has it), show it. */
  email?: string | null;
}

export function SignupRecoveryCardInline({ email }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState<null | "reset" | "switch">(null);

  const handleResetMySignup = async () => {
    if (!user) {
      toast({
        title: "Sign in first",
        description:
          "To reset a stuck signup we need you signed in to that email. Use 'Use a different email' below if you can't.",
        variant: "destructive",
      });
      return;
    }
    setBusy("reset");
    try {
      const { data: resetData, error } = await supabase.rpc("reset_my_signup");
      if (error) throw error;

      // Free up the email if the post-reset state is fully orphan
      // (no remaining tenancy, no platform role). See SignupRecoveryCard.
      if ((resetData as { should_reap_identity?: boolean } | null)?.should_reap_identity) {
        try {
          const { data: reapData, error: reapErr } = await supabase.functions.invoke(
            "self-reap-orphan-identity",
            { body: {} },
          );
          if (reapErr) {
            console.warn("[SignupRecoveryCardInline] self-reap failed:", reapErr.message);
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
          console.warn("[SignupRecoveryCardInline] self-reap threw:", e);
        }
      }

      toast({
        title: "Signup reset",
        description: "We cleaned up your previous attempt. You can sign up again now.",
      });
      window.location.replace("/signup");
    } catch (e: any) {
      toast({
        title: "Couldn't reset signup",
        description:
          e?.message ?? "Try the 'Use a different email' option below.",
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
        description: "You can now sign in or sign up with a different email.",
      });
      window.location.replace("/signup");
    } catch (e: any) {
      toast({
        title: "Couldn't clear session",
        description:
          e?.message ?? "Try opening a private window as a fallback.",
        variant: "destructive",
      });
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
      <div className="text-xs text-muted-foreground">
        If a previous signup got stuck (verification email never arrived,
        workspace setup failed, or the account is in a half-created state)
        you can recover it without contacting support.
        {email && (
          <span className="block mt-1">
            Detected email: <span className="font-medium">{email}</span>
          </span>
        )}
      </div>

      <Button
        onClick={handleResetMySignup}
        disabled={busy !== null}
        className="w-full"
        variant="outline"
        size="sm"
      >
        {busy === "reset" ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
        )}
        Start over with this email
      </Button>

      <Separator />

      <Button
        onClick={handleSwitchAccount}
        disabled={busy !== null}
        className="w-full"
        variant="ghost"
        size="sm"
      >
        {busy === "switch" ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <UserPlus className="h-3.5 w-3.5 mr-2" />
        )}
        Use a different email
      </Button>

      <p className="text-[11px] text-muted-foreground text-center pt-1">
        Still stuck? Email{" "}
        <a href="mailto:support@accrualflow.systems" className="underline">
          support@accrualflow.systems
        </a>
        .
      </p>
    </div>
  );
}
