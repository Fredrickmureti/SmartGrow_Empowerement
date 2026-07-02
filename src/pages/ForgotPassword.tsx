import { useState } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowLeft, Mail, AlertTriangle } from "lucide-react";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  // Set when the email matches a recent self-reap. In that case the user's
  // auth account no longer exists, so Supabase silently won't actually send
  // a reset email even though resetPasswordForEmail returns success (this
  // is the anti-enumeration default). Surfacing the hint here unblocks
  // users who would otherwise wait forever for a non-existent email.
  const [wasReaped, setWasReaped] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) throw error;

      // Best-effort: probe for a recent self-reap. Non-fatal — the generic
      // success message still shows. This call is rate-limited and only
      // returns true for emails the user themselves reset, so it does NOT
      // enable account enumeration of arbitrary addresses.
      try {
        const { data: reapData } = await supabase.functions.invoke(
          "was-email-reaped",
          { body: { email: email.trim().toLowerCase() } },
        );
        if (reapData?.reaped) setWasReaped(true);
      } catch {
        // ignore — UX hint only
      }

      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Failed to send reset email");
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <AuthLayout
        title="Check your email"
        description="We've sent you a password reset link"
      >
        <div className="space-y-6">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Mail className="h-8 w-8 text-primary" />
            </div>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            If an account exists for <strong>{email}</strong>, we've sent a
            password reset link. Please check your inbox and spam folder.
          </p>
          {wasReaped && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Heads up: you previously chose <strong>Start over with
                this email</strong>, which removed your account. No reset
                email will arrive because there's nothing to reset — please
                sign up again instead.
              </AlertDescription>
            </Alert>
          )}
          {wasReaped && (
            <Button asChild className="w-full">
              <Link to="/signup">Sign up again</Link>
            </Button>
          )}
          <Button asChild variant={wasReaped ? "outline" : "default"} className="w-full">
            <Link to="/login">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to login
            </Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      description="Enter your email and we'll send you a reset link"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Send Reset Link
        </Button>

        <div className="text-center">
          <Link
            to="/login"
            className="text-sm text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="mr-1 inline h-3 w-3" />
            Back to login
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
