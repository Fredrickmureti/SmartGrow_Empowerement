/**
 * MfaEnrollmentCard — TOTP two-step verification management on /me/account.
 *
 * All state lives in Supabase Auth (auth.mfa_*), managed via the JS client's
 * mfa.* methods. We only maintain an audit trail in
 * public.employee_lifecycle_events via record_mfa_lifecycle_event.
 *
 * Recovery codes are intentionally not implemented — Supabase does not mint
 * them natively and the correct posture for this workspace is that a lost
 * device is reset by HR (per the account policy).
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldOff, KeyRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { toast } from "sonner";

type Factor = {
  id: string;
  friendly_name?: string | null;
  factor_type: string;
  status: "verified" | "unverified";
  created_at: string;
};

export function MfaEnrollmentCard() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);

  const [enrolling, setEnrolling] = useState(false);
  const [pending, setPending] = useState<{
    factorId: string;
    qr: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      const all = [...(data?.totp ?? []), ...(data?.phone ?? [])] as Factor[];
      setFactors(all);
    } catch (e: any) {
      console.error("[MfaEnrollmentCard] listFactors failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const verified = factors.filter((f) => f.status === "verified");
  const hasVerified = verified.length > 0;

  const startEnroll = async () => {
    setEnrolling(true);
    try {
      // Clean up any stale unverified factor for a fresh QR each time.
      const stale = factors.find((f) => f.status === "unverified" && f.factor_type === "totp");
      if (stale) {
        try {
          await supabase.auth.mfa.unenroll({ factorId: stale.id });
        } catch (e) {
          console.warn("[MfaEnrollmentCard] failed to clear stale factor", e);
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toLocaleDateString()}`,
      } as any);
      if (error) throw error;
      setPending({
        factorId: data.id,
        qr: (data as any).totp?.qr_code ?? "",
        secret: (data as any).totp?.secret ?? "",
      });
      setCode("");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start MFA enrollment.");
    } finally {
      setEnrolling(false);
    }
  };

  const verifyEnroll = async () => {
    if (!pending) return;
    if (code.length < 6) {
      toast.error("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setVerifying(true);
    try {
      const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({
        factorId: pending.factorId,
      });
      if (cErr) throw cErr;
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: pending.factorId,
        challengeId: challenge.id,
        code,
      });
      if (vErr) throw vErr;
      try {
        await supabase.rpc("record_mfa_lifecycle_event" as any, {
          p_action: "enrolled",
          p_factor_type: "totp",
        });
      } catch (e) {
        console.warn("[MfaEnrollmentCard] audit log failed", e);
      }
      toast.success("Two-step verification enabled.");
      setPending(null);
      setCode("");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Invalid code. Try again.");
    } finally {
      setVerifying(false);
    }
  };

  const cancelPending = async () => {
    if (!pending) return;
    try {
      await supabase.auth.mfa.unenroll({ factorId: pending.factorId });
    } catch {
      /* ignore */
    }
    setPending(null);
    setCode("");
    await refresh();
  };

  const removeFactor = async (factorId: string) => {
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      try {
        await supabase.rpc("record_mfa_lifecycle_event" as any, {
          p_action: "unenrolled",
          p_factor_type: "totp",
        });
      } catch (e) {
        console.warn("[MfaEnrollmentCard] audit log failed", e);
      }
      toast.success("Two-step verification removed.");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not remove factor.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Two-step verification
          {hasVerified ? (
            <Badge className="ml-1" variant="secondary">
              On
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Add a time-based code from an authenticator app (Google Authenticator, 1Password, Authy) in addition to your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : hasVerified ? (
          <>
            <ul className="space-y-2 text-sm">
              {verified.map((f) => (
                <li key={f.id} className="flex items-center justify-between border-b last:border-b-0 pb-2 last:pb-0">
                  <div>
                    <div className="font-medium">{f.friendly_name || "Authenticator app"}</div>
                    <div className="text-xs text-muted-foreground">
                      Enrolled {new Date(f.created_at).toLocaleDateString()} · {f.factor_type.toUpperCase()}
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <ShieldOff className="h-4 w-4 mr-1" /> Remove
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove two-step verification?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Your account will sign in with password only until you add another factor. If you lose access, your HR admin must reset it.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeFactor(f.id)}>Remove</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
            <Separator />
            <p className="text-xs text-muted-foreground">
              Lost your device? Contact your HR admin to reset two-step verification.
            </p>
          </>
        ) : pending ? (
          <div className="space-y-3">
            <p className="text-sm">
              Scan the QR code with your authenticator app, then enter the 6-digit code to finish enabling.
            </p>
            {pending.qr ? (
              <img
                src={pending.qr}
                alt="TOTP QR code"
                className="h-40 w-40 border rounded bg-white p-2"
              />
            ) : null}
            {pending.secret ? (
              <div className="text-xs text-muted-foreground">
                Can't scan? Enter this secret manually:{" "}
                <code className="rounded bg-muted px-1 py-0.5">{pending.secret}</code>
              </div>
            ) : null}
            <div>
              <Label>6-digit code</Label>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelPending} disabled={verifying}>
                Cancel
              </Button>
              <Button onClick={verifyEnroll} disabled={verifying || code.length < 6}>
                {verifying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Enable
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Not enabled. Add an authenticator app to keep your account safer.
            </div>
            <Button onClick={startEnroll} disabled={enrolling}>
              {enrolling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
              Set up
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default MfaEnrollmentCard;
