/**
 * MyAccount — the User Account & Identity surface at `/me/account`.
 *
 * This is deliberately separate from `/me/profile` (HR record) because
 * they have different owners:
 *   - /me/profile → employees table (HR-owned + employee-managed personal
 *     fields), backed by v_my_employee_profile + update_own_employee_personal.
 *   - /me/account → auth.users / profiles (Identity + User Account),
 *     backed by supabase.auth.updateUser and the profiles table.
 *
 * Sub-sections:
 *   1. Sign-in — email (read-only), password self-service via Supabase.
 *   2. Preferences — theme, notification channels (deferred to per-app
 *      settings), UI locale.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Mail, Lock, Palette, LogOut, ShieldAlert, History } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, PageBody } from "@/design-system";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { EmailChangeCard } from "@/components/me/EmailChangeCard";
import { MfaEnrollmentCard } from "@/components/me/MfaEnrollmentCard";
import { toast } from "sonner";

export default function MyAccount() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <>
      <PageHeader
        title="My account"
        description="How you sign in, secure your account, and set personal preferences."
      />
      <PageBody>
        <div className="space-y-4">
          {/* Sign-in identity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="h-4 w-4" /> Sign-in email
              </CardTitle>
              <CardDescription>
                Your login identity. Changing this requires a verification email.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="flex items-center gap-3">
                <span>{user?.email}</span>
                <Badge variant="secondary">Managed by identity</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                To change your sign-in email, contact your workspace administrator.
              </p>
            </CardContent>
          </Card>

          {/* Password */}
          <PasswordCard />

          {/* Recent sign-in activity */}
          <LoginHistoryCard />



          {/* Preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Palette className="h-4 w-4" /> Preferences
              </CardTitle>
              <CardDescription>Personal display preferences for this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Theme</div>
                <div className="text-xs text-muted-foreground">Light, dark, or follow system.</div>
              </div>
              <ThemeToggle />
            </CardContent>
          </Card>

          {/* Session */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> Session
              </CardTitle>
              <CardDescription>Sign out of this device.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                onClick={async () => {
                  await qc.cancelQueries();
                  qc.clear();
                  await signOut();
                  navigate("/login", { replace: true });
                }}
              >
                <LogOut className="h-4 w-4 mr-2" /> Sign out
              </Button>
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function PasswordCard() {
  const { user } = useAuth();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const update = async () => {
    if (pw.length < 8) { toast.error("Password must be at least 8 characters."); return; }
    if (pw !== pw2) { toast.error("Passwords do not match."); return; }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      toast.success("Password updated.");
      setPw(""); setPw2("");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update password.");
    } finally { setSaving(false); }
  };

  const emailReset = async () => {
    if (!user?.email) return;
    setResetting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      toast.success("Password reset link sent to your email.");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not send reset link.");
    } finally { setResetting(false); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Lock className="h-4 w-4" /> Password
        </CardTitle>
        <CardDescription>Change your password or request a reset link.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>New password</Label>
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <Label>Confirm password</Label>
            <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={emailReset} disabled={resetting || !user?.email}>
            {resetting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Email me a reset link
          </Button>
          <Button onClick={update} disabled={saving || !pw}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Update password
          </Button>
        </div>
        <Separator />
        <p className="text-xs text-muted-foreground">
          Passwords must be at least 8 characters. If your workspace enforces SSO, changing your password here has no effect on your login.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Login history — last 10 sign-in events for the current user.
// Backed by public.login_history, which already has an owner-select RLS
// policy ("Users can view own login history").
// ---------------------------------------------------------------------------

function LoginHistoryCard() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["my-login-history", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("login_history" as any)
        .select("id, created_at, ip_address, user_agent, status, is_new_device")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string; created_at: string; ip_address: string | null;
        user_agent: string | null; status: string | null; is_new_device: boolean | null;
      }>;
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" /> Recent sign-in activity
        </CardTitle>
        <CardDescription>
          The last 10 sign-in attempts for this account. Contact your admin if you see anything you don't recognise.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !data || data.length === 0 ? (
          <div className="text-muted-foreground">No sign-in history recorded yet.</div>
        ) : (
          <ul className="space-y-2">
            {data.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 border-b last:border-b-0 pb-2 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{new Date(r.created_at).toLocaleString()}</span>
                    {r.status && r.status !== "success" && (
                      <Badge variant="destructive" className="text-[10px]">{r.status}</Badge>
                    )}
                    {r.is_new_device && <Badge variant="secondary" className="text-[10px]">New device</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {r.ip_address ?? "unknown IP"} · {r.user_agent ?? "unknown device"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
