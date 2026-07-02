import { normalizeError } from "@/services/resilience";
/**
 * AdminSessionsCard — list and revoke this admin's active sessions.
 *
 * Reads from `platform_admin_sessions` (filtered by the current admin via
 * `useAdminSession.fetchSessions(user.id)`) and revokes via the
 * `revoke-admin-session` edge function so the action is gated by the
 * is_platform_admin check on the server, not just RLS.
 *
 * The current session (most-recent active row for this admin) is marked
 * "This device" and cannot be revoked from here — admins sign out the
 * current device through the normal logout flow.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminSession, type AdminSession } from "@/hooks/useAdminSession";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, LogOut, Monitor, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export function AdminSessionsCard() {
  const { user } = useAuth();
  const { sessions, fetchSessions } = useAdminSession();
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      await fetchSessions(user.id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Most-recent active session for this admin = "this device".
  // Mirrors the server-side logic in revoke-admin-session ("all_others").
  const currentSessionId = useMemo(() => {
    if (!sessions.length) return null;
    const sorted = [...sessions].sort(
      (a, b) =>
        new Date(b.session_started_at).getTime() -
        new Date(a.session_started_at).getTime(),
    );
    return sorted[0]?.id ?? null;
  }, [sessions]);

  const revokeOne = async (s: AdminSession) => {
    if (s.id === currentSessionId) return;
    setRevokingId(s.id);
    try {
      const { error } = await supabase.functions.invoke("revoke-admin-session", {
        body: { session_id: s.id },
      });
      if (error) throw error;
      toast.success("Session revoked");
      await refresh();
    } catch (err: any) {
      toast.error(normalizeError(err).message ?? "Could not revoke session");
    } finally {
      setRevokingId(null);
    }
  };

  const revokeAllOthers = async () => {
    setRevokingAll(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "revoke-admin-session",
        { body: { all_others: true } },
      );
      if (error) throw error;
      toast.success(
        `Signed out of ${data?.revoked ?? 0} other session${
          (data?.revoked ?? 0) === 1 ? "" : "s"
        }`,
      );
      await refresh();
    } catch (err: any) {
      toast.error(normalizeError(err).message ?? "Could not revoke other sessions");
    } finally {
      setRevokingAll(false);
    }
  };

  const otherSessionsCount = sessions.filter((s) => s.id !== currentSessionId).length;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-primary" />
            Active sessions
          </CardTitle>
          <CardDescription>
            Devices currently signed in to this admin account.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={revokeAllOthers}
            disabled={revokingAll || otherSessionsCount === 0}
          >
            {revokingAll && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Sign out everywhere else
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading sessions…" : "No active sessions found."}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sessions.map((s) => {
              const isCurrent = s.id === currentSessionId;
              return (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-4 p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {parseUserAgent(s.user_agent)}
                      </span>
                      {isCurrent && (
                        <Badge variant="secondary" className="text-xs">
                          This device
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Started{" "}
                      {formatDistanceToNow(new Date(s.session_started_at), {
                        addSuffix: true,
                      })}{" "}
                      · last active{" "}
                      {formatDistanceToNow(new Date(s.last_activity_at), {
                        addSuffix: true,
                      })}
                    </div>
                    {s.ip_address && (
                      <div className="text-xs text-muted-foreground font-mono">
                        {s.ip_address}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeOne(s)}
                    disabled={isCurrent || revokingId === s.id}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    {revokingId === s.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <LogOut className="h-4 w-4 mr-1" />
                        Revoke
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Cheap UA → human label. Avoids pulling in a parser dependency for this
 * one place. If the UA is missing we fall back to "Unknown device".
 */
function parseUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";
  return `${browser} on ${os}`;
}
