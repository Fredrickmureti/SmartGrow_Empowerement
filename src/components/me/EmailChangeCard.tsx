/**
 * EmailChangeCard — self-service sign-in email change surface on /me/account.
 *
 * Business event: employee changes their sign-in email. Two systems are
 * affected — Supabase Auth (identity) and employees.work_email (HR record).
 * They are decoupled:
 *   1. Supabase Auth flips only after the double-opt-in verification.
 *   2. The work_email field flips only after HR approves a change request.
 *
 * This component orchestrates both halves and records the intent for the
 * audit trail via public.log_identity_email_change_intent.
 */
import { useState } from "react";
import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { toast } from "sonner";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailChangeCard() {
  const { user } = useAuth();
  const { employee } = useCurrentEmployee();
  const [newEmail, setNewEmail] = useState("");
  const [reason, setReason] = useState("");
  const [alsoUpdateWorkEmail, setAlsoUpdateWorkEmail] = useState(true);
  const [saving, setSaving] = useState(false);

  // Supabase exposes the pending email change on user.new_email when the
  // first confirmation has not yet completed.
  const pendingEmail = (user as any)?.new_email ?? null;

  const currentAuthEmail = user?.email ?? "";


  const submit = async () => {
    const target = newEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(target)) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (target === currentAuthEmail.toLowerCase()) {
      toast.error("That is already your sign-in email.");
      return;
    }
    setSaving(true);
    try {
      // 1) Record intent + fan out to HR admins so they know a change is
      //    being verified. This is best-effort; do not block the auth call.
      try {
        await supabase.rpc("log_identity_email_change_intent" as any, {
          p_new_email: target,
          p_reason: reason || null,
        });
      } catch (err) {
        console.warn("[EmailChangeCard] log_identity_email_change_intent failed", err);
      }

      // 2) Fire Supabase's double-opt-in email change.
      const { error } = await supabase.auth.updateUser(
        { email: target },
        { emailRedirectTo: `${window.location.origin}/me/account` },
      );
      if (error) throw error;

      // 3) If they asked, and the employee record actually has a work_email
      //    that would be inconsistent, open an HR change request for
      //    work_email. HR reviews payroll/records-side impact independently.
      if (alsoUpdateWorkEmail && employee?.id) {
        try {
          await supabase.rpc("submit_profile_change_request" as any, {
            p_field_key: "work_email",
            p_new_value: target,
            p_reason: reason || "Aligning work email with new sign-in email",
          });
        } catch (err: any) {
          console.warn("[EmailChangeCard] work_email change-request failed", err);
          toast.warning(
            "Verification email sent, but HR change request for work email could not be created.",
          );
        }
      }

      toast.success(
        "We sent a verification link to both your current and new email addresses. Confirm both to complete the change.",
      );
      setNewEmail("");
      setReason("");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start the email change.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" /> Change sign-in email
        </CardTitle>
        <CardDescription>
          You will be asked to verify both your current and new addresses. Your HR record is updated separately, after review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pendingEmail ? (
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertDescription>
              A change to <b>{pendingEmail}</b> is pending verification. Check both mailboxes and click the confirmation links.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>Current sign-in email</Label>
            <Input value={currentAuthEmail} disabled />
          </div>
          <div>
            <Label>New sign-in email</Label>
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="email"
            />
          </div>
        </div>

        <div>
          <Label>Reason (optional)</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. company email domain change"
          />
        </div>

        {employee?.id ? (
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={alsoUpdateWorkEmail}
              onCheckedChange={(v) => setAlsoUpdateWorkEmail(v === true)}
              className="mt-0.5"
            />
            <span>
              Also request HR to update my work email on my employee record.
            </span>

          </label>
        ) : null}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={saving || !newEmail}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Send verification
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          If your workspace uses SSO, changes here have no effect on how you actually sign in — contact your admin instead.
        </p>
      </CardContent>
    </Card>
  );
}

export default EmailChangeCard;
