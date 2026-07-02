/**
 * WorkspaceRecoveryCard
 *
 * Generic stuck-state escape hatch shown by BoundedLoader when a workspace
 * resolution takes too long. Three concrete actions instead of a wall:
 *
 *   - Retry: re-fetch session and try again
 *   - Switch organization: jump to /select-organization
 *   - Sign out: nuke session and start clean
 *
 * Mirrors the SignupRecoveryCard pattern but for already-onboarded users
 * who hit a transient session-resolution stall (e.g. RLS lag right after
 * provisioning, Realtime backlog after wake-from-sleep).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, RefreshCw, Building2, LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";

interface WorkspaceRecoveryCardProps {
  title?: string;
  description?: string;
}

export function WorkspaceRecoveryCard({
  title = "Taking longer than expected",
  description = "We're still loading your workspace. This usually resolves with a quick refresh.",
}: WorkspaceRecoveryCardProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { refreshSession } = useSession();
  const [busy, setBusy] = useState<null | "retry" | "switch" | "signout">(null);

  const handleRetry = async () => {
    setBusy("retry");
    try {
      await refreshSession();
      // Soft reload to re-evaluate route guards once session is fresh.
      window.location.reload();
    } finally {
      setBusy(null);
    }
  };

  const handleSwitch = () => {
    setBusy("switch");
    navigate("/select-organization", { replace: true });
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
          <div className="mx-auto w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center mb-3">
            <AlertTriangle className="h-6 w-6 text-warning" />
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={handleRetry}
            disabled={busy !== null}
            className="w-full"
            variant="default"
          >
            {busy === "retry" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Retry now
          </Button>
          <Button
            onClick={handleSwitch}
            disabled={busy !== null}
            className="w-full"
            variant="outline"
          >
            <Building2 className="h-4 w-4 mr-2" />
            Choose a different workspace
          </Button>
          <Separator />
          <Button
            onClick={handleSignOut}
            disabled={busy !== null}
            className="w-full"
            variant="ghost"
          >
            {busy === "signout" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <LogOut className="h-4 w-4 mr-2" />
            )}
            Sign out and start over
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
