/**
 * AdminLogin
 *
 * Collects credentials and authenticates platform admins.
 *
 * Persona-routing (admin vs tenant) is handled exclusively by:
 *   1. <RedirectIfAuthenticated> mounted around this route in App.tsx —
 *      it bounces an already-signed-in user to /admin-management or
 *      /dashboard *before* this component renders.
 *   2. <AdminProtectedRoute> on /admin-management/* — if a tenant user
 *      somehow lands here, the wrapper shows the persona-mismatch screen.
 *
 * PIN login parity (added in this loop):
 *   Platform admins (and the operators they invite) frequently enable PIN
 *   login from /admin-management/profile → Security. Until now the admin
 *   login form only accepted email+password, leaving those users stranded.
 *   We mirror the tenant <EnhancedLoginForm> flow:
 *     - check_pin_status RPC — does this email have a PIN?
 *     - If yes AND the platform-wide `allow_admin_pin_login` toggle is on,
 *       expose a PIN tab that calls the existing `pin-login` edge function
 *       (single source of truth for PIN auth).
 *     - Auto-submits when the OTP slots fill, same UX as tenant login.
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  ShieldCheck,
  AlertCircle,
  KeyRound,
  Lock,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";

type AuthMethod = "password" | "pin";

export default function AdminLogin() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PIN state — mirrors EnhancedLoginForm contract.
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [pinAvailable, setPinAvailable] = useState(false);
  const [pinLength, setPinLength] = useState(4);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [isCheckingPin, setIsCheckingPin] = useState(false);
  const [pinLocked, setPinLocked] = useState(false);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);

  // Platform-wide toggle. Defaults to true (matches AdminSettings default)
  // so existing PIN users are never silently locked out.
  const [pinFeatureEnabled, setPinFeatureEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from("platform_settings")
        .select("setting_value")
        .eq("setting_key", "allow_admin_pin_login")
        .maybeSingle();
      if (cancelled) return;
      if (data?.setting_value !== undefined && data?.setting_value !== null) {
        setPinFeatureEnabled(String(data.setting_value) === "true");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced PIN-availability check after the user types a valid email.
  useEffect(() => {
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setPinAvailable(false);
      setAuthMethod("password");
      return;
    }

    const timer = setTimeout(async () => {
      setIsCheckingPin(true);
      try {
        const { data, error: rpcError } = await (supabase as any).rpc(
          "check_pin_status",
          { p_email: trimmed },
        );
        if (rpcError || !data) {
          setPinAvailable(false);
          return;
        }
        const result = data as { has_pin: boolean; pin_length: number };
        setPinAvailable(!!result.has_pin && pinFeatureEnabled);
        if (result.has_pin) setPinLength(result.pin_length || 4);
      } catch {
        setPinAvailable(false);
      } finally {
        setIsCheckingPin(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [email, pinFeatureEnabled]);

  // Auto-submit PIN once all slots are filled — same UX as tenant login.
  useEffect(() => {
    if (
      authMethod === "pin" &&
      pin.length === pinLength &&
      !isLoading &&
      !pinLocked
    ) {
      handlePinLogin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, pinLength, authMethod, isLoading, pinLocked]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { error: signInError } = await signIn(email, password);
      if (signInError) {
        setError(signInError.message || "Failed to sign in");
        setIsLoading(false);
        return;
      }
      // Success — keep the spinner up. <RedirectIfAuthenticated> takes
      // over within a tick and routes the user to /admin-management
      // (admin) or /dashboard (tenant).
    } catch (err: any) {
      setError(err?.message || "Failed to sign in");
      setIsLoading(false);
    }
  };

  const handlePinLogin = async () => {
    if (pin.length !== pinLength) return;
    setIsLoading(true);
    setError(null);
    setPinError(null);

    try {
      const { data, error: invokeError } = await supabase.functions.invoke(
        "pin-login",
        { body: { email: email.trim(), pin } },
      );

      if (invokeError) {
        setPinError("PIN verification failed");
        setPin("");
        setIsLoading(false);
        return;
      }

      if (!data?.success) {
        setPinError(data?.error || "Invalid PIN");
        if (data?.locked) setPinLocked(true);
        if (data?.attempts_remaining !== undefined) {
          setAttemptsRemaining(data.attempts_remaining);
        }
        setPin("");
        setIsLoading(false);
        return;
      }

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      if (sessionError) {
        setPinError("Failed to establish session");
        setPin("");
        setIsLoading(false);
        return;
      }
      // RedirectIfAuthenticated handles routing once the auth state propagates.
    } catch (err: any) {
      setPinError(err?.message || "PIN login failed");
      setPin("");
      setIsLoading(false);
    }
  };

  const firstGroupSize = Math.ceil(pinLength / 2);
  const secondGroupSize = pinLength - firstGroupSize;

  return (
    <div className="min-h-screen flex">
      {/* Left Panel - Admin Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
        <div className="relative z-10 flex flex-col justify-center px-12 text-white">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <span className="text-2xl font-bold">Admin Portal</span>
            </div>
            <h1 className="text-4xl font-bold mb-4">
              Platform
              <br />
              Administration
            </h1>
            <p className="text-lg text-white/70 max-w-md">
              Secure access to manage organizations, users, and platform settings.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span>Manage all organizations</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span>Platform-wide analytics</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span>Configure subscription plans</span>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 right-0 w-96 h-96 bg-white/5 rounded-full blur-3xl" />
        <div className="absolute top-20 right-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl" />
      </div>

      {/* Right Panel - Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-background">
        <div className="w-full max-w-md animate-fade-in">
          <div className="lg:hidden mb-8 text-center">
            <div className="flex items-center justify-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold">Admin Portal</span>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-foreground">Admin Sign In</h2>
            <p className="text-muted-foreground mt-2">
              Enter your credentials to access the admin dashboard.
            </p>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-4">
            {/* Email — always visible */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setPin("");
                  setPinError(null);
                  setPinLocked(false);
                  setAttemptsRemaining(null);
                }}
                placeholder="admin@example.com"
                required
                disabled={isLoading}
              />
            </div>

            {isCheckingPin && email.trim().includes("@") && (
              <div className="flex items-center gap-2 px-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Checking sign-in options…
                </span>
              </div>
            )}

            {pinAvailable && (
              <div className="flex rounded-lg border border-border bg-muted/30 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod("password");
                    setPinError(null);
                    setPin("");
                  }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
                    authMethod === "password"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Lock className="h-4 w-4" />
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod("pin");
                    setPinError(null);
                  }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
                    authMethod === "pin"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <KeyRound className="h-4 w-4" />
                  PIN
                </button>
              </div>
            )}

            {authMethod === "password" && (
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    disabled={isLoading}
                  />
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Sign In to Admin
                </Button>
              </form>
            )}

            {authMethod === "pin" && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground text-center">
                  Enter your {pinLength}-digit PIN
                </p>

                {pinLocked ? (
                  <div className="flex flex-col items-center gap-3 p-4 bg-destructive/10 rounded-lg">
                    <p className="text-sm text-destructive font-medium">
                      Too many failed attempts. Please try again later or use
                      your password.
                    </p>
                  </div>
                ) : (
                  <div className="flex justify-center">
                    <InputOTP
                      maxLength={pinLength}
                      value={pin}
                      onChange={(val) => {
                        setPin(val);
                        setPinError(null);
                      }}
                      disabled={isLoading || pinLocked}
                      containerClassName="justify-center"
                      autoFocus
                    >
                      <InputOTPGroup>
                        {Array.from({ length: firstGroupSize }).map((_, i) => (
                          <InputOTPSlot
                            key={i}
                            index={i}
                            className={cn(
                              "w-12 h-14 text-xl",
                              pinError && "border-destructive",
                            )}
                          />
                        ))}
                      </InputOTPGroup>
                      <InputOTPSeparator />
                      <InputOTPGroup>
                        {Array.from({ length: secondGroupSize }).map((_, i) => (
                          <InputOTPSlot
                            key={i + firstGroupSize}
                            index={i + firstGroupSize}
                            className={cn(
                              "w-12 h-14 text-xl",
                              pinError && "border-destructive",
                            )}
                          />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                )}

                {pinError && !pinLocked && (
                  <div className="flex items-center justify-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                    <p className="text-sm text-destructive">
                      {pinError}
                      {attemptsRemaining !== null &&
                        ` (${attemptsRemaining} attempts left)`}
                    </p>
                  </div>
                )}

                {isLoading && (
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">
                      Verifying…
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 text-center">
            <p className="text-sm text-muted-foreground">
              Not an admin?{" "}
              <Link to="/login" className="text-primary hover:underline">
                Go to regular login
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
