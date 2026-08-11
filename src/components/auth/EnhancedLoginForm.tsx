import { normalizeError } from "@/services/resilience";
/**
 * Enhanced Login Form
 * Supports email+password login AND email+PIN login.
 * PIN login is available when the user has enabled it in their settings.
 * 
 * Flow:
 * 1. User enters email
 * 2. System checks if PIN login is available for that email
 * 3. If yes: show tabs for "Password" and "PIN"
 * 4. PIN login calls the pin-login edge function (no prior session needed)
 */

import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, KeyRound, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp";
import { cn } from "@/lib/utils";
import { SignupRecoveryCardInline } from "@/components/auth/SignupRecoveryCardInline";

type AuthMethod = "password" | "pin";

export function EnhancedLoginForm() {
  const location = useLocation();
  const locationState = location.state as { email?: string; fromTimeout?: boolean } | null;

  // Allow ?email= URL param to pre-fill (used by SignupForm when it bounces
  // an already-registered user here). Falls back to router state, then "".
  const urlEmail = (() => {
    try {
      return new URLSearchParams(location.search).get("email") ?? "";
    } catch { return ""; }
  })();

  const [email, setEmail] = useState(urlEmail || locationState?.email || "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const fromTimeout = locationState?.fromTimeout === true;

  // PIN state
  const [pinAvailable, setPinAvailable] = useState(false);
  const [pinLength, setPinLength] = useState(4);
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [isCheckingPin, setIsCheckingPin] = useState(false);
  const [pinLocked, setPinLocked] = useState(false);
  const [_pinLockedUntil, setPinLockedUntil] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);

  const { signIn } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Check PIN availability when email changes
  const checkPinForEmail = async (emailToCheck: string) => {
    setIsCheckingPin(true);
    try {
      const { data, error } = await (supabase as any).rpc("check_pin_status", {
        p_email: emailToCheck,
      });
      if (!error && data) {
        const result = data as { has_pin: boolean; pin_length: number };
        setPinAvailable(result.has_pin);
        if (result.has_pin) {
          setPinLength(result.pin_length);
          // Auto-select PIN when pre-filled from timeout
          if (fromTimeout) {
            setAuthMethod("pin");
          }
        }
      } else {
        setPinAvailable(false);
      }
    } catch {
      setPinAvailable(false);
    } finally {
      setIsCheckingPin(false);
    }
  };

  // Immediate check when email is pre-filled (e.g. from timeout)
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  useEffect(() => {
    if (initialCheckDone) return;
    const prefilled = locationState?.email?.trim();
    if (prefilled && prefilled.includes("@")) {
      setInitialCheckDone(true);
      checkPinForEmail(prefilled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced check when user types email manually
  useEffect(() => {
    if (initialCheckDone && email.trim() === locationState?.email?.trim()) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setPinAvailable(false);
      setAuthMethod("password");
      return;
    }

    const timer = setTimeout(() => {
      checkPinForEmail(trimmedEmail);
    }, 400);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // Auto-submit PIN when complete
  useEffect(() => {
    if (authMethod === "pin" && pin.length === pinLength && !isLoading && !pinLocked) {
      handlePinLogin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, pinLength, authMethod, isLoading, pinLocked]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error, user: signedInUser } = await signIn(email, password);

    if (error) {
      const isUnconfirmedEmail =
        error.message?.toLowerCase().includes("email not confirmed") ||
        error.message?.toLowerCase().includes("email confirmation");

      if (isUnconfirmedEmail) {
        toast({
          title: "Email not verified",
          description: "Please verify your email before signing in.",
        });
        navigate("/verify-email", { state: { email } });
        setIsLoading(false);
        return;
      }

      toast({
        title: "Error signing in",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }

    await handlePostLogin(signedInUser);
    setIsLoading(false);
  };

  const handlePinLogin = async () => {
    if (pin.length !== pinLength) return;
    setIsLoading(true);
    setPinError(null);

    try {
      const { data, error } = await supabase.functions.invoke("pin-login", {
        body: { email: email.trim(), pin },
      });

      if (error) {
        setPinError("PIN verification failed");
        setPin("");
        setIsLoading(false);
        return;
      }

      if (!data.success) {
        setPinError(data.error || "Invalid PIN");
        if (data.locked) {
          setPinLocked(true);
          setPinLockedUntil(data.locked_until);
        }
        if (data.attempts_remaining !== undefined) {
          setAttemptsRemaining(data.attempts_remaining);
        }
        setPin("");
        setIsLoading(false);
        return;
      }

      // Set the session from the edge function response
      const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      if (sessionError) {
        setPinError("Failed to establish session");
        setPin("");
        setIsLoading(false);
        return;
      }

      await handlePostLogin(sessionData?.user ?? null);
    } catch (err: any) {
      setPinError(err.message || "PIN login failed");
      setPin("");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePostLogin = async (authedUser: import("@supabase/supabase-js").User | null) => {
    // IMPORTANT: use the user returned by the sign-in call itself. Do NOT
    // call `supabase.auth.getUser()` here — right after `signInWithPassword`
    // it can transiently return `null` while the session propagates, and
    // `resolvePostLoginDestination(null)` returns `/login`, which produces
    // exactly the "toast shows 'Welcome back' but the page stays on the
    // login form" symptom (navigate('/login') is a no-op on /login).
    toast({
      title: "Welcome back!",
      description: "You have successfully signed in.",
    });

    // Honor deep-link recovery: ?redirect= or router state.from set by
    // ProtectedRoute when bouncing the user here.
    let intendedPath: string | null = null;
    try {
      const fromQuery = new URLSearchParams(location.search).get("redirect");
      if (fromQuery && fromQuery.startsWith("/") && !fromQuery.startsWith("//")) {
        intendedPath = fromQuery;
      }
    } catch { /* ignore */ }
    if (!intendedPath) {
      const stateFrom = (location.state as { from?: { pathname?: string } } | null)
        ?.from?.pathname;
      if (stateFrom && typeof stateFrom === "string" && stateFrom.startsWith("/")) {
        intendedPath = stateFrom;
      }
    }
    // Never allow the intended path to be an auth page — that would bounce
    // the newly signed-in user right back to the form.
    if (intendedPath && /^\/(login|signup|forgot-password|reset-password|auth\/callback)(\/|$|\?)/.test(intendedPath)) {
      intendedPath = null;
    }

    const { resolvePostLoginDestination } = await import("@/lib/auth/postLoginRedirect");
    let destination = await resolvePostLoginDestination({ user: authedUser, intendedPath });
    // Belt-and-braces: if resolution ever hands us back an auth route while
    // we KNOW auth just succeeded, fall back to the authenticated landing
    // surface instead of no-op'ing on the current /login route.
    if (!destination || destination === "/login" || destination === location.pathname) {
      destination = "/home";
    }
    navigate(destination, { replace: true });
  };

  const firstGroupSize = Math.ceil(pinLength / 2);
  const secondGroupSize = pinLength - firstGroupSize;

  return (
    <div className="space-y-6">
      {/* Session timeout banner */}
      {fromTimeout && (
        <div className="flex items-center gap-2 p-3 bg-muted border border-border rounded-lg">
          <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            Session timed out. Sign in to continue.
          </p>
        </div>
      )}

      {/* Email field — always visible */}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setPin("");
            setShowPin(false);
            setPinError(null);
            setPinLocked(false);
          }}
          required
          className="h-11"
        />
      </div>

      {/* PIN check loading indicator */}
      {isCheckingPin && email.trim().includes("@") && (
        <div className="flex items-center gap-2 p-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Checking login options...</span>
        </div>
      )}

      {/* Auth method tabs — only show when PIN is available */}
      {pinAvailable && (
        <div className="flex rounded-lg border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => {
              setAuthMethod("password");
              setPinError(null);
              setPin("");
              setShowPin(false);
            }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              authMethod === "password"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
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
              setShowPin(false);
            }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
              authMethod === "pin"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <KeyRound className="h-4 w-4" />
            PIN
          </button>
        </div>
      )}

      {/* Password login */}
      {authMethod === "password" && (
        <form onSubmit={handlePasswordLogin} className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                to="/forgot-password"
                className="text-sm text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-11 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <Button type="submit" className="w-full h-11" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      )}

      {/* PIN login */}
      {authMethod === "pin" && (
        <div className="space-y-4">
          <div className="text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Enter your {pinLength}-digit PIN
            </p>

            {pinLocked ? (
              <div className="flex flex-col items-center gap-3 p-4 bg-destructive/10 rounded-lg">
                <p className="text-sm text-destructive font-medium">
                  Too many failed attempts. Please try again later.
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
                          pinError && "border-destructive"
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
                          pinError && "border-destructive"
                        )}
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>
            )}
          </div>

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
              <span className="text-sm text-muted-foreground">Verifying...</span>
            </div>
          )}
        </div>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Don't have an account?{" "}
        <Link
          to="/signup"
          className="text-primary font-medium hover:underline"
        >
          Create one
        </Link>
      </p>

      {/*
        Stuck-signup recovery (audit v2 — C2). Reachable here because users
        often discover they're locked out only when they try to sign in
        ("email already registered" / can't get past verify). Same RPC and
        same three actions as the OnboardingSetup recovery card; collapsed
        by default so it's invisible to the 99% who don't need it.
      */}
      <RecoveryAccordion email={email} />
    </div>
  );
}

function RecoveryAccordion({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline w-full text-center"
      >
        {open ? "Hide recovery options" : "Trouble signing in? Recover a stuck signup"}
      </button>
      {open && (
        <div className="mt-3">
          <SignupRecoveryCardInline email={email || null} />
        </div>
      )}
    </div>
  );
}

