import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, CheckCircle2 } from "lucide-react";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [isValidSession, setIsValidSession] = useState(false);

  useEffect(() => {
    // Listen for the PASSWORD_RECOVERY event from Supabase
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === "PASSWORD_RECOVERY") {
          // User clicked the recovery link and Supabase verified the token
          setIsValidSession(true);
          setIsVerifying(false);
        } else if (event === "SIGNED_IN" && session) {
          // Check if this is a recovery session by looking at the URL or session
          const hashParams = new URLSearchParams(window.location.hash.substring(1));
          const type = hashParams.get("type");
          if (type === "recovery") {
            setIsValidSession(true);
            setIsVerifying(false);
          }
        }
      }
    );

    // Also check if there's already a valid session (user might have refreshed)
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      
      // Check URL hash for recovery token
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const accessToken = hashParams.get("access_token");
      const type = hashParams.get("type");
      
      if (accessToken && type === "recovery") {
        // Token is in URL, Supabase will process it
        // Wait for the auth state change event
        return;
      }
      
      if (session) {
        // There's an active session, allow password reset
        setIsValidSession(true);
        setIsVerifying(false);
      } else {
        // No session and no token in URL
        setIsVerifying(false);
        setError("Invalid or expired reset link. Please request a new one.");
      }
    };

    // Small delay to allow Supabase to process the hash
    const timer = setTimeout(checkSession, 500);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setSuccess(true);
      
      // Sign out after password reset so user logs in with new password
      await supabase.auth.signOut();
      
      setTimeout(() => navigate("/login"), 2000);
    } catch (err: any) {
      setError(err.message || "Failed to reset password");
    } finally {
      setIsLoading(false);
    }
  };

  if (isVerifying) {
    return (
      <AuthLayout
        title="Verifying..."
        description="Please wait while we verify your reset link"
      >
        <div className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AuthLayout>
    );
  }

  if (success) {
    return (
      <AuthLayout
        title="Password reset successful"
        description="Your password has been updated"
      >
        <div className="space-y-6">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            Your password has been successfully reset. Redirecting you to login...
          </p>
        </div>
      </AuthLayout>
    );
  }

  if (!isValidSession) {
    return (
      <AuthLayout
        title="Invalid Reset Link"
        description="This password reset link is invalid or has expired"
      >
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{error || "Please request a new password reset link."}</AlertDescription>
          </Alert>
          <Button onClick={() => navigate("/forgot-password")} className="w-full">
            Request New Reset Link
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your new password below"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="password">New Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm Password</Label>
          <Input
            id="confirmPassword"
            type="password"
            placeholder="••••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Reset Password
        </Button>
      </form>
    </AuthLayout>
  );
}
