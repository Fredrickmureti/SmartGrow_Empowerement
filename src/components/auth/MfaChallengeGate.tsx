/**
 * MfaChallengeGate — post-login AAL2 gate.
 *
 * Runs after a session is established (password or PIN sign-in, or session
 * restore on refresh). If the user has a verified TOTP factor but the
 * current assurance level is still `aal1`, we render a challenge form
 * instead of the protected children. On successful `mfa.verify`, Supabase
 * upgrades the session to `aal2` and children render normally.
 *
 * Users without a verified factor are passed through unchanged, so this
 * gate is invisible for tenants that haven't opted into 2FA.
 *
 * Recovery from a lost device is handled by HR admin reset (see
 * MfaEnrollmentCard) — this component intentionally offers no bypass.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface MfaChallengeGateProps {
  children: React.ReactNode;
}

type GateState = "checking" | "pass" | "challenge";

export function MfaChallengeGate({ children }: MfaChallengeGateProps) {
  const [state, setState] = useState<GateState>("checking");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const evaluate = useCallback(async () => {
    try {
      const { data: aal, error: aalErr } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalErr) throw aalErr;

      // Already at aal2, or no next level required → pass through.
      if (!aal || aal.currentLevel === aal.nextLevel) {
        setState("pass");
        return;
      }
      if (aal.nextLevel !== "aal2") {
        setState("pass");
        return;
      }

      const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
      if (fErr) throw fErr;
      const verified = factors?.totp?.find((f) => f.status === "verified");
      if (!verified) {
        // Factor unverified or missing — do not block sign-in.
        setState("pass");
        return;
      }

      setFactorId(verified.id);
      setState("challenge");
    } catch {
      // Fail open: if the MFA API is unreachable, don't lock the user out.
      setState("pass");
    }
  }, []);

  useEffect(() => {
    evaluate();
  }, [evaluate]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId || code.length < 6) return;
    setSubmitting(true);
    try {
      const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (cErr || !challenge) throw cErr ?? new Error("Challenge failed");
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (vErr) throw vErr;
      setCode("");
      setState("pass");
    } catch {
      toast.error("Invalid or expired verification code. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    // Session listener elsewhere will bounce to /login.
  };

  if (state === "checking") {
    return <BrandedLoader message="Verifying two-step security..." />;
  }

  if (state === "challenge") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <CardTitle>Two-step verification</CardTitle>
            </div>
            <CardDescription>
              Enter the 6-digit code from your authenticator app to continue.
              Lost your device? Contact your HR admin to reset access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mfa-code">Verification code</Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting || code.length !== 6}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={handleSignOut}
                  disabled={submitting}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Sign out
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
