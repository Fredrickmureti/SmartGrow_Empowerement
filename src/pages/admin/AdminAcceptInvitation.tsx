import { normalizeError } from "@/services/resilience";
/**
 * AdminAcceptInvitation — public page for accepting a platform team invite.
 *
 * Flow (Stripe-style single-page accept-and-set-password):
 *   1. Read ?token= from URL → call validate_platform_invitation RPC.
 *   2. Branch by signed-in state:
 *      a) Not signed in, no auth user with invitation.email → show "Set
 *         password and join" form. signUp() with do_not_reap metadata so
 *         the orphan reaper never touches the new admin. After session is
 *         live → call accept_platform_invitation → /admin-management.
 *      b) Not signed in, auth user with invitation.email exists → show
 *         "Sign in to continue" with the email pre-filled.
 *      c) Signed in as the invitation email → one-click "Accept invitation"
 *         button → call accept_platform_invitation → /admin-management.
 *      d) Signed in as a different email → "Sign out and continue as X".
 */
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Shield,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Mail,
  Eye,
  EyeOff,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";

type InvitationState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; email: string; role: string; expiresAt: string };

export default function AdminAcceptInvitation() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { user, isLoading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InvitationState>({ kind: "loading" });
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Validate token on mount
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setInvite({ kind: "invalid", reason: "missing_token" });
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase.rpc(
          "validate_platform_invitation" as never,
          { _token: token } as never,
        );
        if (error) throw error;
        const result = data as {
          valid: boolean;
          reason?: string;
          email?: string;
          role?: string;
          expires_at?: string;
        };
        if (cancelled) return;
        if (!result?.valid) {
          setInvite({ kind: "invalid", reason: result?.reason ?? "unknown" });
        } else {
          setInvite({
            kind: "valid",
            email: result.email!,
            role: result.role!,
            expiresAt: result.expires_at!,
          });
        }
      } catch (e: any) {
        if (!cancelled) {
          setInvite({ kind: "invalid", reason: e?.message ?? "lookup_failed" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Acceptance helper — reused by both branches A and C.
  const acceptForUser = async (userId: string) => {
    const { data, error } = await supabase.rpc(
      "accept_platform_invitation" as never,
      { _token: token, _user_id: userId } as never,
    );
    if (error) throw error;
    const r = data as { success: boolean; error?: string; message?: string };
    if (!r?.success) throw new Error(r?.error ?? "Acceptance failed");
    return r.message ?? "Welcome to the platform team!";
  };

  // Branch C: signed in as the right email — one-click accept.
  const handleAcceptAsCurrent = async () => {
    if (invite.kind !== "valid" || !user) return;
    setSubmitting(true);
    try {
      const msg = await acceptForUser(user.id);
      toast.success(msg);
      navigate("/admin-management", { replace: true });
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Could not accept invitation");
    } finally {
      setSubmitting(false);
    }
  };

  // Branch A: no auth user yet — sign up + accept in one flow.
  const handleSignUpAndAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invite.kind !== "valid") return;
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const { data: signUpData, error: signUpError } =
        await supabase.auth.signUp({
          email: invite.email,
          password,
          options: {
            // No emailRedirectTo — token IS the proof of email ownership.
            data: {
              full_name: fullName || null,
              is_platform_admin_signup: true,
              do_not_reap: "true",
              onboarding_completed: true, // skip tenant onboarding entirely
            },
          },
        });
      if (signUpError) throw signUpError;

      const newUserId = signUpData.user?.id;
      if (!newUserId) throw new Error("Signup did not return a user id");

      // If the project requires email confirmation, signUp returns a user
      // but no session — accept_platform_invitation works anyway because it
      // matches by profiles.email. We still try to accept immediately.
      try {
        const msg = await acceptForUser(newUserId);
        toast.success(msg);
      } catch (acceptErr: any) {
        console.warn(
          "[AcceptInvitation] accept failed during signup, will retry on first sign-in:",
          acceptErr?.message,
        );
        toast.info(
          "Account created. If your project requires email verification, accept the invitation again after verifying.",
        );
      }

      // If there's an active session now, head into the admin app. Otherwise
      // tell the user to verify and sign in.
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session) {
        navigate("/admin-management", { replace: true });
      } else {
        navigate("/admin-management/login", {
          replace: true,
          state: { email: invite.email },
        });
      }
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Could not create your account");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────
  if (invite.kind === "loading" || authLoading) {
    return (
      <Frame>
        <CardContent className="py-10 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Validating your invitation…
        </CardContent>
      </Frame>
    );
  }

  if (invite.kind === "invalid") {
    const friendly =
      invite.reason === "expired"
        ? "This invitation has expired. Ask the inviter to send you a new one."
        : invite.reason === "accepted"
        ? "This invitation has already been used."
        : invite.reason === "cancelled"
        ? "This invitation was cancelled."
        : invite.reason === "missing_token"
        ? "No invitation token was provided in the link."
        : "This invitation could not be found. The link may be incorrect.";
    return (
      <Frame>
        <CardHeader className="text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle className="mt-3">Invitation not available</CardTitle>
          <CardDescription>{friendly}</CardDescription>
        </CardHeader>
        <CardFooter className="justify-center">
          <Button variant="outline" asChild>
            <Link to="/">Go home</Link>
          </Button>
        </CardFooter>
      </Frame>
    );
  }

  // Branch D: signed in as wrong email
  if (user && user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Frame>
        <CardHeader className="text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-amber-500/10 flex items-center justify-center">
            <Mail className="h-6 w-6 text-amber-600" />
          </div>
          <CardTitle className="mt-3">Wrong account</CardTitle>
          <CardDescription>
            You're signed in as <strong>{user.email}</strong> but this
            invitation is for <strong>{invite.email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex-col gap-2">
          <Button
            className="w-full"
            onClick={async () => {
              await signOut();
              // Stay on this page — re-render will land on Branch B.
            }}
          >
            Sign out and continue as {invite.email}
          </Button>
        </CardFooter>
      </Frame>
    );
  }

  // Branch C: signed in as the right user
  if (user) {
    return (
      <Frame>
        <CardHeader className="text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="mt-3">Join the platform team</CardTitle>
          <CardDescription>
            You've been invited as <strong>{invite.role}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <div className="text-sm text-muted-foreground">
            Signed in as <strong>{user.email}</strong>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            className="w-full"
            onClick={handleAcceptAsCurrent}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            Accept invitation
          </Button>
        </CardFooter>
      </Frame>
    );
  }

  // Branch A/B: not signed in. Try sign-up; the API will tell us if the
  // email already exists. We expose a "Sign in instead" link for clarity.
  const passwordReqs = [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Contains uppercase letter", met: /[A-Z]/.test(password) },
    { label: "Contains lowercase letter", met: /[a-z]/.test(password) },
    { label: "Contains a number", met: /\d/.test(password) },
  ];
  const allMet = passwordReqs.every((r) => r.met);

  return (
    <Frame>
      <CardHeader className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Shield className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="mt-3">Join the platform team</CardTitle>
        <CardDescription>
          Set a password for <strong>{invite.email}</strong> to accept your
          invitation as <strong>{invite.role}</strong>.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSignUpAndAccept}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fullName">Your name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Operator"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a strong password"
                required
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {password && (
              <div className="space-y-1 mt-2">
                {passwordReqs.map((r) => (
                  <div
                    key={r.label}
                    className="flex items-center gap-2 text-xs"
                  >
                    {r.met ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <X className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span
                      className={
                        r.met ? "text-green-600" : "text-muted-foreground"
                      }
                    >
                      {r.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !allMet || !fullName.trim()}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Set password & accept
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Already have an account with this email?{" "}
            <Link
              to={`/admin-management/login?email=${encodeURIComponent(
                invite.email,
              )}&redirect=${encodeURIComponent(
                `/admin-management/accept-invitation?token=${token}`,
              )}`}
              className="text-primary hover:underline"
            >
              Sign in to accept
            </Link>
          </p>
        </CardFooter>
      </form>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}
