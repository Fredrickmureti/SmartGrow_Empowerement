import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

/**
 * /auth/callback — single deterministic landing zone for Supabase email
 * confirmation links (signup verification, magic link, email change).
 *
 * It handles BOTH transport shapes:
 *   - implicit:  #access_token=…&refresh_token=…&type=signup
 *   - PKCE:      ?code=…
 *
 * Outcomes:
 *   1) Token valid           → setSession / exchangeCodeForSession,
 *                              forward to /onboarding-setup.
 *   2) Token invalid AND the email was recently self-reaped via the
 *      "Start over with this email" recovery flow → tell the user the
 *      link is no longer valid because they reset their signup, and
 *      send them back to /signup.
 *   3) Token invalid otherwise → generic "link expired" with a path
 *      back to /verify-email or /login.
 *
 * This page replaces the silent "Invalid login credentials" dead-end
 * users used to hit after a self-reap invalidated their old confirmation
 * link.
 */

type Outcome =
  | { state: "working" }
  | { state: "success" }
  | { state: "reaped"; email?: string; reapedAt?: string }
  | { state: "expired"; email?: string };

function decodeEmailFromJwt(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    const email = typeof json?.email === "string" ? json.email : null;
    return email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function checkReaped(email: string | null): Promise<{
  reaped: boolean;
  reaped_at?: string;
}> {
  if (!email) return { reaped: false };
  try {
    const { data, error } = await supabase.functions.invoke(
      "was-email-reaped",
      { body: { email } },
    );
    if (error || !data) return { reaped: false };
    return {
      reaped: !!data.reaped,
      reaped_at: data.reaped_at,
    };
  } catch {
    return { reaped: false };
  }
}

export default function AuthCallback() {
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<Outcome>({ state: "working" });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const hash = window.location.hash || "";
      const search = window.location.search || "";

      const hashParams = new URLSearchParams(
        hash.startsWith("#") ? hash.substring(1) : hash,
      );
      const queryParams = new URLSearchParams(search);

      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");
      const code = queryParams.get("code");
      const errorCode = hashParams.get("error") || queryParams.get("error");
      const errorDescription =
        hashParams.get("error_description") ||
        queryParams.get("error_description");

      // Best-effort email extraction for friendlier copy and the reap probe.
      const emailFromJwt = decodeEmailFromJwt(accessToken);

      // ── Path A: explicit auth error in URL (Supabase already rejected). ──
      if (errorCode) {
        console.warn(
          "[AuthCallback] Supabase returned auth error:",
          errorCode,
          errorDescription,
        );
        const reap = await checkReaped(emailFromJwt);
        if (cancelled) return;
        if (reap.reaped) {
          setOutcome({
            state: "reaped",
            email: emailFromJwt ?? undefined,
            reapedAt: reap.reaped_at,
          });
        } else {
          setOutcome({
            state: "expired",
            email: emailFromJwt ?? undefined,
          });
        }
        return;
      }

      // ── Path B: PKCE code exchange. ──
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (cancelled) return;
        if (!error) {
          window.history.replaceState(null, "", "/auth/callback");
          setOutcome({ state: "success" });
          setTimeout(() => navigate("/onboarding-setup", { replace: true }), 600);
          return;
        }
        console.warn(
          "[AuthCallback] exchangeCodeForSession failed:",
          error.message,
        );
        const reap = await checkReaped(emailFromJwt);
        if (cancelled) return;
        setOutcome(
          reap.reaped
            ? {
                state: "reaped",
                email: emailFromJwt ?? undefined,
                reapedAt: reap.reaped_at,
              }
            : { state: "expired", email: emailFromJwt ?? undefined },
        );
        return;
      }

      // ── Path C: implicit-flow hash tokens. ──
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (cancelled) return;
        if (!error) {
          window.history.replaceState(null, "", "/auth/callback");
          setOutcome({ state: "success" });
          setTimeout(() => navigate("/onboarding-setup", { replace: true }), 600);
          return;
        }
        console.warn("[AuthCallback] setSession failed:", error.message);
        const reap = await checkReaped(emailFromJwt);
        if (cancelled) return;
        setOutcome(
          reap.reaped
            ? {
                state: "reaped",
                email: emailFromJwt ?? undefined,
                reapedAt: reap.reaped_at,
              }
            : { state: "expired", email: emailFromJwt ?? undefined },
        );
        return;
      }

      // ── Path D: no tokens at all. ──
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.user?.email_confirmed_at) {
        setOutcome({ state: "success" });
        setTimeout(() => navigate("/onboarding-setup", { replace: true }), 200);
        return;
      }
      setOutcome({ state: "expired" });
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (outcome.state === "working") {
    return (
      <AuthLayout title="Confirming your email" subtitle="Just a moment…">
        <div className="flex flex-col items-center gap-4 py-6">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Verifying the link from your inbox.
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (outcome.state === "success") {
    return (
      <AuthLayout title="Email verified" subtitle="Taking you to setup…">
        <div className="flex flex-col items-center gap-4 py-6">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
          <p className="text-sm text-muted-foreground">
            You're signed in. Redirecting to onboarding.
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (outcome.state === "reaped") {
    return (
      <AuthLayout
        title="This link is no longer valid"
        subtitle="You reset your signup, so we need to start fresh."
      >
        <div className="space-y-5">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              You previously chose <strong>Start over with this email</strong>,
              which removed your unfinished account
              {outcome.email ? <> for <strong>{outcome.email}</strong></> : null}.
              The confirmation link you just clicked points at that removed
              account, so it can't sign you in. Please sign up again — the
              email is now free to reuse.
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // expired
  return (
    <AuthLayout
      title="This confirmation link has expired"
      subtitle="Request a fresh one to finish setting up your account."
    >
      <div className="space-y-5">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            The link is no longer valid. This usually happens when it's older
            than the confirmation window, or has already been used.
          </AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link
            to="/verify-email"
            state={outcome.email ? { email: outcome.email } : undefined}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Send me a new link
          </Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}