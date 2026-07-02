/**
 * NoWorkspaceEmptyState
 *
 * In-place terminal screen rendered when an authenticated user has
 * resolved with zero org memberships. Replaces the previous behavior
 * of `<Navigate to="/select-organization?returnTo=…">`, which mutated
 * the URL synchronously and produced the visible "/select-organization"
 * flash on every reload (see .lovable/plan.md — workspace-resolution
 * audit).
 *
 * Industry rule we're aligning to: the URL is the user's intent. We
 * never rewrite it just to signal an empty/loading state.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Plus, LogOut, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";

interface NoWorkspaceEmptyStateProps {
  /**
   * True when the user previously completed onboarding but has no
   * memberships now (e.g. removed by an admin). Surfaces "switch
   * workspace" instead of "create one".
   */
  onboardingCompleted?: boolean;
}

export function NoWorkspaceEmptyState({ onboardingCompleted }: NoWorkspaceEmptyStateProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { refreshSession } = useSession();
  const [busy, setBusy] = useState<null | "retry" | "create" | "signout">(null);

  const handleRetry = async () => {
    setBusy("retry");
    try {
      await refreshSession();
    } finally {
      setBusy(null);
    }
  };

  const handlePrimary = () => {
    if (onboardingCompleted) {
      // User has finished onboarding before — they just have nothing
      // they currently belong to. The picker shows the empty state.
      setBusy("create");
      navigate("/select-organization", { replace: false });
      return;
    }
    setBusy("create");
    navigate("/onboarding-setup", { replace: false });
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
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>No workspace yet</CardTitle>
          <CardDescription>
            {onboardingCompleted
              ? "You're not a member of any workspace right now. You can switch to another one or create a new one."
              : "Let's set up your first workspace to get started."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={handlePrimary} disabled={busy !== null} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            {onboardingCompleted ? "Choose or create a workspace" : "Create your workspace"}
          </Button>
          <Button
            onClick={handleRetry}
            disabled={busy !== null}
            variant="outline"
            className="w-full"
          >
            {busy === "retry" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
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
        </CardContent>
      </Card>
    </div>
  );
}