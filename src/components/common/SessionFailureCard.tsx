/**
 * SessionFailureCard
 *
 * Rendered when the session bootstrap RPC (`get_user_session_data`) could
 * not produce a payload. This card is state-aware: it distinguishes
 * "waiting for the network to come back" from "actively retrying" from
 * a genuinely terminal failure, so a transient offline blip is never
 * presented as a fatal crash.
 *
 * Behaviour:
 *   - offline / waiting_for_network → live "Waiting for connection…"
 *     surface; auto-retries fire from SessionContext when the
 *     ConnectivityManager transitions back to `online`.
 *   - retrying                       → live "Reconnecting… (attempt N)".
 *   - idle + persistent error        → actionable retry/sign-out card.
 *
 * Industry rule: never rewrite the URL for a transient/server error.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, LogOut, RefreshCw, Loader2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { connectivityManager, type ConnectivityStatus } from "@/services/resilience/ConnectivityManager";
import { normalizeError, type ErrorKind } from "@/services/resilience/ErrorNormalizer";

interface SessionFailureCardProps {
  error?: (Error & { kind?: ErrorKind }) | null;
}

export function SessionFailureCard({ error }: SessionFailureCardProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { refreshSession, sessionRecovery } = useSession();
  const [busy, setBusy] = useState<null | "retry" | "signout">(null);
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(() =>
    connectivityManager.getStatus(),
  );

  useEffect(() => {
    return connectivityManager.subscribe(setConnectivity);
  }, []);

  const isOffline = connectivity === "offline";
  const isWaiting = sessionRecovery.status === "waiting_for_network" || isOffline;
  const isRetrying = sessionRecovery.status === "retrying";
  const isTransient = isWaiting || isRetrying;

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

  // Transient surface: no scary "workspace couldn't load" copy, no
  // terminal iconography. Retry happens automatically from
  // SessionContext on `offline → online`; the button is a manual
  // shortcut only.
  if (isTransient) {
    const attemptSuffix =
      sessionRecovery.attempt > 0 ? ` (attempt ${sessionRecovery.attempt})` : "";
    const title = isWaiting ? "Waiting for connection" : "Reconnecting";
    const description = isWaiting
      ? "You're offline. We'll pick up automatically as soon as your connection returns — no need to reload."
      : `We're re-establishing your session${attemptSuffix}. This usually takes a few seconds.`;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
              {isWaiting ? (
                <WifiOff className="h-6 w-6 text-muted-foreground" />
              ) : (
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
              )}
            </div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              onClick={handleRetry}
              disabled={busy !== null || isWaiting}
              variant="outline"
              className="w-full"
            >
              {busy === "retry" ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Try now
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Persistent failure: server responded with something we can't recover
  // from automatically (e.g. auth_invalid, permission_denied on the RPC,
  // or an unknown server error after the retry budget). Offer explicit
  // manual retry and sign-out. Copy is driven by the normalized error
  // catalog — we never render `error.message` verbatim.
  const normalized = useMemo(() => {
    const kind = error?.kind ?? sessionRecovery.lastErrorKind ?? undefined;
    if (kind) {
      // Round-trip through the catalog to get canonical title/message.
      return normalizeError({ kind, message: "" });
    }
    return normalizeError(error ?? new Error("Session unavailable"));
  }, [error, sessionRecovery.lastErrorKind]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>{normalized.title}</CardTitle>
          <CardDescription>{normalized.message}</CardDescription>
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
        </CardContent>
      </Card>
    </div>
  );
}
