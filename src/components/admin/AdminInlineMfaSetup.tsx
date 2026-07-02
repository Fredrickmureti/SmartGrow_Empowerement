/**
 * AdminInlineMfaSetup
 * Renders MFA enrollment inline within AdminProtectedRoute.
 * No navigation, no AdminDashboardLayout, no business providers.
 * This is a standalone centered UI that handles the full TOTP flow.
 */

import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck, KeyRound, Loader2, CheckCircle, AlertTriangle, Copy, Shield } from "lucide-react";
import { toast } from "sonner";

type SetupStep = "loading" | "already_enrolled" | "enrolling" | "verify" | "success" | "error";

interface AdminInlineMfaSetupProps {
  onComplete: () => void;
}

export function AdminInlineMfaSetup({ onComplete }: AdminInlineMfaSetupProps) {
  const [step, setStep] = useState<SetupStep>("loading");
  const [qrUri, setQrUri] = useState("");
  const [secret, setSecret] = useState("");
  const [factorId, setFactorId] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    checkExistingMfa();
  }, []);

  const checkExistingMfa = async () => {
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      const hasVerified = data?.totp?.some(f => f.status === "verified");
      if (hasVerified) {
        // Already enrolled — signal parent immediately
        onComplete();
      } else {
        await startEnrollment();
      }
    } catch {
      await startEnrollment();
    }
  };

  const startEnrollment = async () => {
    try {
      setStep("enrolling");
      // Unenroll any unverified factors first
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const factor of existing?.totp || []) {
        if (factor.status !== "verified") {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Platform Admin TOTP",
      });

      if (error) throw error;

      setQrUri(data.totp.uri);
      setSecret(data.totp.secret);
      setFactorId(data.id);
      setStep("verify");
    } catch (err: any) {
      console.error("MFA enrollment error:", err);
      setErrorMsg(err.message || "Failed to start MFA enrollment");
      setStep("error");
    }
  };

  const handleVerify = async () => {
    if (otpCode.length !== 6) return;
    setIsVerifying(true);
    setErrorMsg("");

    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: otpCode,
      });
      if (verifyError) throw verifyError;

      setStep("success");
      toast.success("Two-factor authentication enabled successfully");

      // Signal parent after brief success display
      setTimeout(() => {
        onComplete();
      }, 1500);
    } catch (err: any) {
      console.error("MFA verify error:", err);
      setErrorMsg(err.message || "Verification failed. Please try again.");
      setOtpCode("");
    } finally {
      setIsVerifying(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    toast.success("Secret copied to clipboard");
  };

  if (step === "loading" || step === "enrolling") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <BrandedLoader message="Preparing MFA setup..." />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Platform admin branding header */}
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <Shield className="h-5 w-5 text-primary" />
          <span className="text-sm font-medium">Platform Administration</span>
        </div>

        <Card>
          {step === "verify" && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <KeyRound className="h-8 w-8 text-primary" />
                </div>
                <CardTitle>Set Up Two-Factor Authentication</CardTitle>
                <CardDescription>
                  Two-factor authentication is required for platform admin access.
                  Scan the QR code with your authenticator app, then enter the 6-digit code.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* QR Code */}
                <div className="flex justify-center">
                  <div className="p-4 bg-white rounded-lg">
                    <QRCodeSVG value={qrUri} size={200} />
                  </div>
                </div>

                {/* Manual secret */}
                <div className="text-center space-y-1">
                  <p className="text-xs text-muted-foreground">Can't scan? Enter this key manually:</p>
                  <div className="flex items-center justify-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1 rounded font-mono break-all">
                      {secret}
                    </code>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copySecret}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* OTP Input */}
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm font-medium">Enter verification code</p>
                  <InputOTP
                    maxLength={6}
                    value={otpCode}
                    onChange={setOtpCode}
                    onComplete={handleVerify}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>

                  {errorMsg && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
                    </Alert>
                  )}

                  <Button
                    onClick={handleVerify}
                    disabled={otpCode.length !== 6 || isVerifying}
                    className="w-full mt-2"
                  >
                    {isVerifying ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying...</>
                    ) : (
                      <><ShieldCheck className="h-4 w-4 mr-2" /> Verify & Enable 2FA</>
                    )}
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === "success" && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-accent flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-primary" />
                </div>
                <CardTitle>2FA Enabled Successfully</CardTitle>
                <CardDescription>
                  Your account is now protected. Loading admin dashboard...
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </CardContent>
            </>
          )}

          {step === "error" && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="h-8 w-8 text-destructive" />
                </div>
                <CardTitle>Setup Failed</CardTitle>
                <CardDescription>{errorMsg}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <Button onClick={startEnrollment}>Try Again</Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
