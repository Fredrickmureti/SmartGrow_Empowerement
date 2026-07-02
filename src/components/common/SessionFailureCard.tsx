/**
 * SessionFailureCard
 *
 * Terminal in-place screen rendered when the session bootstrap RPC
 * (`get_user_session_data`) has exhausted its retry budget without
 * returning a usable payload. Differs from `NoWorkspaceEmptyState`
 * in intent: we *don't know* whether the user has a workspace —
 * the server didn't tell us.
 *
 * Industry rule: never rewrite the URL for a transient/server error.
 * Offer a retry; offer sign-out; otherwise stay put.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, LogOut, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";

interface SessionFailureCardProps {
  error?: Error | null;
}

export function SessionFailureCard({ error }: SessionFailureCardProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { refreshSession } = useSession();
  const [busy, setBusy] = useState<null | "retry" | "signout">(null);

  const handleRetry = async () => {
    setBusy("retry");
    try {
      await refreshSession();
    } finally {
      setBusy(null);
    }
  };

  const handleSignOut = async () => {
    setBusy("signout");
    try {
      await signOut();
      navigate("/login", { replace: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>We couldn't load your workspace</CardTitle>
          <CardDescription>
            Something went wrong while loading your account. This is usually
            temporary.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={handleRetry} disabled={busy !== null} className="w-full">
            {busy === "retry" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Try again
          </Button>
          <Separator />
          <Button
            onClick={handleSignOut}
            disabled={busy !== null}
            variant="ghost"
            className="w-full"
          >
            {busy === "signout" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <LogOut className="h-4 w-4 mr-2" />
            )}
            Sign out
          </Button>
          {error?.message ? (
            <p className="text-xs text-muted-foreground text-center pt-2 break-words">
              {error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
