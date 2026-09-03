import { useState, useEffect } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useInvitation } from "@/hooks/useInvitation";
import { useOrganization } from "@/hooks/useOrganization";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { 
  Loader2, 
  Building2, 
  CheckCircle2, 
  XCircle, 
  Eye, 
  EyeOff,
  Check,
  X,
  Mail
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";

const roleLabels: Record<string, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  internal: "Internal User",
  accountant: "Internal User",
  staff: "Internal User",
  cashier: "Internal User",
  viewer: "Internal User",
  portal: "Portal User",
};

export default function AcceptInvitation() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();
  const { user, isLoading: authLoading, signIn } = useAuth();
  const { switchOrganization, refreshOrganizations } = useOrganization();
  const { toast } = useToast();

  const { 
    invitation, 
    isLoading: inviteLoading, 
    error: inviteError,
    isExpired,
    isAlreadyAccepted,
    route,
    acceptInvitation,
  } = useInvitation(token);

  // Form states
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptSuccess, setAcceptSuccess] = useState(false);
  const [joinedOrgId, setJoinedOrgId] = useState<string | null>(null);

  // Clear any stale session on mount to prevent "Invalid Refresh Token" errors
  useEffect(() => {
    const clearStaleSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session) {
          await supabase.auth.signOut({ scope: 'local' });
        }
      } catch (_) {
        // Ignore - just trying to clear stale state
      }
    };
    clearStaleSession();
  }, []);

  // Pre-fill email from invitation
  useEffect(() => {
    if (invitation?.email) {
      setEmail(invitation.email);
    }
  }, [invitation]);

  // Auto-accept if user is already logged in with correct email
  useEffect(() => {
    if (!authLoading && user && invitation && !isExpired && !isAlreadyAccepted && !isAccepting && !acceptSuccess) {
      // Only auto-accept if emails match
      if (user.email?.toLowerCase() === invitation.email.toLowerCase()) {
        handleAcceptInvitation();
      }
    }
  }, [user, authLoading, invitation, isExpired, isAlreadyAccepted, isAccepting, acceptSuccess]);

  // Handle organization switch after successful join
  useEffect(() => {
    if (acceptSuccess && joinedOrgId) {
      const switchAndRedirect = async () => {
        await refreshOrganizations();
        switchOrganization(joinedOrgId);
        setTimeout(() => navigate("/dashboard"), 1500);
      };
      switchAndRedirect();
    }
  }, [acceptSuccess, joinedOrgId]);

  const passwordRequirements = [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Contains uppercase letter", met: /[A-Z]/.test(password) },
    { label: "Contains lowercase letter", met: /[a-z]/.test(password) },
    { label: "Contains a number", met: /\d/.test(password) },
  ];

  const allRequirementsMet = passwordRequirements.every((req) => req.met);

  const handleAcceptInvitation = async () => {
    if (isAccepting) return; // Prevent double-calls
    
    setIsAccepting(true);
    const result = await acceptInvitation();
    
    if (result.success) {
      setAcceptSuccess(true);
      setJoinedOrgId(result.organization_id || null);
      toast({
        title: "Welcome to the team!",
        description: `You've joined ${invitation?.organization?.name || "the organization"}.`,
      });
    } else {
      toast({
        title: "Error accepting invitation",
        description: result.error,
        variant: "destructive",
      });
      setIsAccepting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invitation) return;

    // Verify email matches
    if (email.toLowerCase() !== invitation.email.toLowerCase()) {
      toast({
        title: "Email mismatch",
        description: `Please sign in with ${invitation.email}`,
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    const { error } = await signIn(email, password);

    if (error) {
      toast({
        title: "Error signing in",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
    // If successful, the useEffect will handle accepting the invitation
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invitation || !allRequirementsMet) return;

    setIsSubmitting(true);

    // Create account with auto-confirm via edge function
    const { data, error: fnError } = await supabase.functions.invoke("accept-invitation", {
      body: {
        token: invitation.token,
        create_account: true,
        email: invitation.email,
        password,
        full_name: fullName,
      },
    });

    if (fnError || data?.error) {
      toast({
        title: "Error creating account",
        description: fnError?.message || data?.error,
        variant: "destructive",
      });
      setIsSubmitting(false);
      return;
    }

    // Account created and added to org — wait briefly for DB triggers to settle, then sign in
    await new Promise(r => setTimeout(r, 800));
    const { error: signInError } = await signIn(invitation.email, password);

    if (signInError) {
      // Account created but sign in failed - redirect to login
      toast({
        title: "Account created!",
        description: "Please sign in with your new credentials.",
      });
      navigate("/login");
    } else {
      setAcceptSuccess(true);
      setJoinedOrgId(data?.organization_id || null);
      toast({
        title: "Welcome!",
        description: `You've joined ${invitation.organization?.name || "the organization"}.`,
      });
    }
    setIsSubmitting(false);
  };

  // Loading state
  if (inviteLoading || authLoading) {
    return (
      <AuthLayout title="Validating Invitation" subtitle="Please wait...">
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground">Checking your invitation...</p>
        </div>
      </AuthLayout>
    );
  }

  // Error state (invalid/expired token)
  if (inviteError || isExpired || isAlreadyAccepted) {
    return (
      <AuthLayout 
        title={isAlreadyAccepted ? "Already Accepted" : "Invalid Invitation"} 
        subtitle={isExpired ? "This invitation has expired" : ""}
      >
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <XCircle className="h-8 w-8 text-destructive" />
          </div>
          <p className="text-muted-foreground mb-6">
            {inviteError || (isAlreadyAccepted 
              ? "This invitation has already been used."
              : "Please request a new invitation from your team administrator."
            )}
          </p>
          <div className="flex gap-3">
            <Button asChild>
              <Link to="/login">Go to Login</Link>
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // Success state
  if (acceptSuccess) {
    return (
      <AuthLayout title="Welcome!" subtitle="You're now part of the team">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mb-4">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <h3 className="font-semibold text-lg mb-2">
            You've joined {invitation?.organization?.name}
          </h3>
          <p className="text-muted-foreground mb-4">
            Redirecting to your dashboard...
          </p>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </AuthLayout>
    );
  }

  // User is logged in but with wrong email
  if (user && user.email?.toLowerCase() !== invitation?.email.toLowerCase()) {
    return (
      <AuthLayout title="Wrong Account" subtitle="Email mismatch">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center mb-4">
            <Mail className="h-8 w-8 text-warning" />
          </div>
          <p className="text-muted-foreground mb-2">
            You're signed in as <strong>{user.email}</strong>
          </p>
          <p className="text-muted-foreground mb-6">
            This invitation was sent to <strong>{invitation?.email}</strong>
          </p>
          <Button 
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.reload();
            }}
          >
            Sign out and continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // User is logged in with correct email - show accepting state
  if (user && isAccepting) {
    return (
      <AuthLayout title="Joining Organization" subtitle="Please wait...">
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground">Adding you to the team...</p>
        </div>
      </AuthLayout>
    );
  }

  // Main invitation view - show login/signup options
  return (
    <AuthLayout 
      title="You're Invited!" 
      subtitle="Join your team on the platform"
    >
      <div className="space-y-6">
        {/* Organization Info */}
        <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/50 border">
          <Avatar className="h-16 w-16 mb-3">
            <AvatarFallback className="bg-primary/10 text-primary text-xl">
              <Building2 className="h-8 w-8" />
            </AvatarFallback>
          </Avatar>
          <h3 className="font-semibold text-lg">
            {invitation?.organization?.name}
          </h3>
          <p className="text-sm text-muted-foreground mb-2">
            You've been invited to join as
          </p>
          <Badge variant="secondary" className="bg-primary/10 text-primary">
            {roleLabels[invitation?.role || "viewer"]}
          </Badge>
        </div>

        {/* Invited Email Notice */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
          <Mail className="h-4 w-4 text-blue-500 flex-shrink-0" />
          <span className="text-muted-foreground">
            Invitation sent to: <strong className="text-foreground">{invitation?.email}</strong>
          </span>
        </div>

        {/*
          Server-decided branch (see resolve-invitation edge function).
          The page never asks the user to self-classify as new vs returning;
          `route` is "signup", "login", "auto_accept", or "already_member".
          "auto_accept" is handled by the existing useEffect above which
          calls handleAcceptInvitation as soon as the matching signed-in
          user is detected, so here we only render signup/login forms.
        */}
        {route === "login" && (
          <div className="mt-4">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  value={email}
                  disabled
                  className="h-11 bg-muted"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
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
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full h-11" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign in & Join"
                )}
              </Button>

              <p className="text-center text-sm">
                <Link to="/forgot-password" className="text-primary hover:underline">
                  Forgot password?
                </Link>
              </p>
            </form>
          </div>
        )}

        {route === "signup" && (
          <div className="mt-4">
            <form onSubmit={handleSignup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="signup-name">Full Name</Label>
                <Input
                  id="signup-name"
                  type="text"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  value={email}
                  disabled
                  className="h-11 bg-muted"
                />
                <p className="text-xs text-muted-foreground">
                  Your account will be created with this email
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="signup-password">Password</Label>
                <div className="relative">
                  <Input
                    id="signup-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Create a strong password"
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
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                {password && (
                  <div className="mt-2 space-y-1">
                    {passwordRequirements.map((req) => (
                      <div key={req.label} className="flex items-center gap-2 text-xs">
                        {req.met ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <X className="h-3 w-3 text-muted-foreground" />
                        )}
                        <span className={req.met ? "text-success" : "text-muted-foreground"}>
                          {req.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Button 
                type="submit" 
                className="w-full h-11" 
                disabled={isSubmitting || !allRequirementsMet || !fullName}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  "Create Account & Join"
                )}
              </Button>
            </form>
          </div>
        )}

        {route === "already_member" && (
          <div className="mt-4 text-center space-y-4">
            <p className="text-muted-foreground">
              You're already part of <strong>{invitation?.organization?.name}</strong>.
            </p>
            <Button asChild className="w-full h-11">
              <Link to="/dashboard">Go to workspace</Link>
            </Button>
          </div>
        )}

        {route === "auto_accept" && (
          <div className="mt-4 flex flex-col items-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
            <p className="text-sm text-muted-foreground">Joining {invitation?.organization?.name}…</p>
          </div>
        )}

        {!route && (
          <div className="mt-4 flex flex-col items-center py-4">
            <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
            <p className="text-sm text-muted-foreground">Preparing your invitation…</p>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
