import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Mail, Loader2, ArrowLeft, RefreshCw, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { normalizeError } from "@/services/resilience";

export default function VerifyEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const { resendConfirmation, user } = useAuth();
  const { toast } = useToast();
  
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resendCount, setResendCount] = useState(0);
  const [verificationDetected, setVerificationDetected] = useState(false);
  const [isPolling, setIsPolling] = useState(true);
  const redirectStartedRef = useRef(false);

  const redirectToOnboarding = useCallback(() => {
    if (redirectStartedRef.current) return;
    redirectStartedRef.current = true;
    setVerificationDetected(true);
    setIsPolling(false);
    window.setTimeout(() => {
      navigate("/onboarding-setup", { replace: true });
    }, 800);
  }, [navigate]);
  
  // Get email from route state or localStorage
  const email = location.state?.email || localStorage.getItem("pendingVerificationEmail") || "";
  const uncertain: boolean = !!location.state?.uncertain;
  
  // Store email in localStorage as backup
  useEffect(() => {
    if (location.state?.email) {
      localStorage.setItem("pendingVerificationEmail", location.state.email);
    }
  }, [location.state?.email]);
  
  // Redirect if user is already verified (immediate check)
  useEffect(() => {
    if (user?.email_confirmed_at) {
      redirectToOnboarding();
    }
  }, [user, redirectToOnboarding]);

  // Listen for auth state changes (same-browser verification)
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        console.log("[VerifyEmail] Auth state change:", event);
        if (event === 'SIGNED_IN' && session?.user?.email_confirmed_at) {
          console.log("[VerifyEmail] User signed in with verified email, redirecting...");
          redirectToOnboarding();
        }
      }
    );
    return () => subscription.unsubscribe();
  }, [redirectToOnboarding]);

  // Poll for verification status — bounded to 5 minutes to avoid runaway
  // background traffic. The onAuthStateChange listener above catches
  // same-browser verifications instantly (free, no network). Polling exists
  // only as a safety net for the same-browser case where the listener may
  // miss an event; cross-browser verification is handled by the manual
  // "I've verified" button below (user re-signs in on this device).
  // Note: getUser() only returns a verified user if a local session exists,
  // so polling cannot detect verifications done in a different browser.
  useEffect(() => {
    if (!email || verificationDetected) return;

    let elapsed = 0;
    const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
    const INTERVAL_MS = 10000; // 10s (was 5s — halves request volume)

    const checkVerification = async () => {
      try {
        const { data: { user: freshUser } } = await supabase.auth.getUser();
        if (freshUser?.email_confirmed_at) {
          redirectToOnboarding();
        }
      } catch (error) {
        console.error("[VerifyEmail] Polling error:", error);
      }
    };

    checkVerification();
    const interval = setInterval(() => {
      elapsed += INTERVAL_MS;
      if (elapsed >= MAX_POLL_MS) {
        clearInterval(interval);
        setIsPolling(false);
        return;
      }
      checkVerification();
    }, INTERVAL_MS);
    return () => clearInterval(interval);
  }, [email, redirectToOnboarding, verificationDetected]);
  
  // Cooldown timer
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldown]);
  
  const handleResend = async () => {
    if (!email || cooldown > 0) return;

    setIsResending(true);

    // State-driven resend: probe the authoritative server state FIRST so
    // we never show "email sent" when no pending account exists to send
    // to (Supabase resend returns 200 in that case too — anti-enumeration).
    try {
      const { data: availability } = await supabase.functions.invoke(
        "check-email-availability",
        { body: { email } },
      );
      if (availability) {
        if (availability.exists && availability.confirmed) {
          toast({
            title: "You're already verified",
            description: "Sign in to continue.",
          });
          setIsResending(false);
          navigate(`/login?email=${encodeURIComponent(email)}`);
          return;
        }
        if (!availability.exists || availability.reaped) {
          toast({
            title: "No pending account found",
            description:
              "There's no pending account for this email. Ask your administrator to send you an invitation.",
            variant: "destructive",
          });
          setIsResending(false);
          navigate("/login");
          return;
        }
        // exists && !confirmed → pending_verification, fall through to resend.
      }
    } catch (probeErr) {
      console.warn("[VerifyEmail] availability probe failed:", probeErr);
      // Fall through — we'd rather attempt resend than block the user on
      // a probe failure.
    }

    const { error } = await resendConfirmation(email);

    if (error) {
      toast({
        title: "Failed to resend email",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } else {
      setResendCount(prev => prev + 1);
      setCooldown(60); // 60 second cooldown
      toast({
        title: "Confirmation email sent",
        description: "Please check your inbox and spam folder.",
      });
    }

    setIsResending(false);
  };

  // Show verification success animation
  if (verificationDetected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", duration: 0.5 }}
          className="text-center"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-6"
          >
            <CheckCircle2 className="w-10 h-10 text-green-500" />
          </motion.div>
          <motion.h2
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-2xl font-bold mb-2"
          >
            Email Verified!
          </motion.h2>
          <motion.p
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-muted-foreground"
          >
            Setting up your workspace...
          </motion.p>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-4"
          >
            <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
          </motion.div>
        </motion.div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-xl border shadow-lg p-8">
          {/* Icon with pulse animation */}
          <div className="relative w-16 h-16 mx-auto mb-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="w-8 h-8 text-primary" />
            </div>
            {isPolling && (
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-primary/30"
                animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            )}
          </div>
          
          {/* Title */}
          <h1 className="text-2xl font-bold text-center mb-2">
            Verify your email
          </h1>
          
          {/* Description */}
          <p className="text-muted-foreground text-center mb-6">
            We've sent a confirmation link to{" "}
            {email ? (
              <span className="font-medium text-foreground">{email}</span>
            ) : (
              "your email address"
            )}
          </p>

          {uncertain && (
            <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <p className="font-medium text-amber-700 dark:text-amber-300 mb-1">
                Signup result was interrupted
              </p>
              <p className="text-muted-foreground">
                Your network dropped the response, but your account was most
                likely created on our side. Please look for the verification
                email below before trying to sign up again — retrying may
                create duplicate accounts. If nothing arrives in a couple of
                minutes, use "Resend confirmation email".
              </p>
            </div>
          )}

          {/* Active monitoring indicator */}
          {isPolling && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground mb-6 bg-muted/50 rounded-lg py-2 px-3"
            >
              <motion.div
                className="w-2 h-2 rounded-full bg-green-500"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              />
              <span>Waiting for verification...</span>
            </motion.div>
          )}
          
          {/* Instructions */}
          <div className="bg-muted/50 rounded-lg p-4 mb-6 space-y-2">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm">Click the link in the email to verify your account</p>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm">Check your spam folder if you don't see it</p>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm">This page will automatically detect when you verify</p>
            </div>
          </div>
          
          {/* Manual continue — covers cross-browser/device verification */}
          <Button
            onClick={async () => {
              const { data: { user: freshUser } } = await supabase.auth.getUser();
              if (freshUser?.email_confirmed_at) {
                redirectToOnboarding();
              } else {
                toast({
                  title: "Not verified yet",
                  description:
                    "If you verified in another browser, please sign in there. Otherwise click the link in the email and try again.",
                });
                navigate("/login", { replace: true });
              }
            }}
            className="w-full h-11 mb-3"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            I've verified my email — continue
          </Button>

          {/* Resend Button */}
          <Button
            onClick={handleResend}
            disabled={isResending || cooldown > 0 || !email}
            variant="outline"
            className="w-full h-11 mb-4"
          >
            {isResending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : cooldown > 0 ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Resend in {cooldown}s
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Resend confirmation email
              </>
            )}
          </Button>
          
          {resendCount > 0 && (
            <p className="text-xs text-muted-foreground text-center mb-4">
              Email resent {resendCount} time{resendCount > 1 ? "s" : ""}
            </p>
          )}
          
          {/* Back to Login */}
          <Link to="/login" className="block">
            <Button variant="ghost" className="w-full h-11">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to sign in
            </Button>
          </Link>
          
          {/* Help text */}
          <p className="text-xs text-muted-foreground text-center mt-6">
            Already verified?{" "}
            <Link to="/login" className="text-primary hover:underline">
              Sign in here
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
