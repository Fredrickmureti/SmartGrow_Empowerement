import { useState } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Clock } from "lucide-react";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

export function LoginForm() {
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get("reason") === "session_expired";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error } = await signIn(email, password);

    if (error) {
      // Check if error is due to unconfirmed email
      const isUnconfirmedEmail = error.message?.toLowerCase().includes("email not confirmed") ||
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

      const n = normalizeError(error);
      toast({
        title: n.title,
        description: n.message,
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }
    
    // Success — route based on account type (platform admin vs tenant).
    toast({
      title: "Welcome back!",
      description: "You have successfully signed in.",
    });

    const { supabase } = await import("@/integrations/supabase/client");
    const { resolvePostLoginDestination } = await import("@/lib/auth/postLoginRedirect");
    const { data: { user: freshUser } } = await supabase.auth.getUser();
    const destination = await resolvePostLoginDestination({ user: freshUser });
    navigate(destination);

    setIsLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {sessionExpired && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Your session expired. Please sign in again to continue.</span>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="h-11"
        />
      </div>

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
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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

      <p className="text-center text-sm text-muted-foreground">
        Don't have an account?{" "}
        <Link to="/signup" className="text-primary font-medium hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}
