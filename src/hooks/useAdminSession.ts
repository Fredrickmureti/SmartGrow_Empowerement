import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface AdminSession {
  id: string;
  admin_user_id: string;
  session_started_at: string;
  last_activity_at: string;
  user_agent: string | null;
  ip_address: string | null;
  is_active: boolean;
  expired_at: string | null;
  forced_logout_by: string | null;
}

const SESSION_TIMEOUT_MINUTES = 480; // 8 hours

export function useAdminSession() {
  const { user } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);

  // Create or resume session on mount
  useEffect(() => {
    if (!user) return;

    const initSession = async () => {
      // Check for existing active session
      const { data: existing } = await supabase
        .from("platform_admin_sessions")
        .select("id, last_activity_at")
        .eq("admin_user_id", user.id)
        .eq("is_active", true)
        .order("session_started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const lastActivity = new Date(existing.last_activity_at);
        const minutesSince = (Date.now() - lastActivity.getTime()) / 60000;

        if (minutesSince < SESSION_TIMEOUT_MINUTES) {
          setSessionId(existing.id);
          // Update activity
          await supabase
            .from("platform_admin_sessions")
            .update({ last_activity_at: new Date().toISOString() })
            .eq("id", existing.id);
          return;
        } else {
          // Expire old session
          await supabase
            .from("platform_admin_sessions")
            .update({ is_active: false, expired_at: new Date().toISOString() })
            .eq("id", existing.id);
        }
      }

      // Create new session
      const { data: newSession } = await supabase
        .from("platform_admin_sessions")
        .insert({
          admin_user_id: user.id,
          user_agent: navigator.userAgent,
        })
        .select("id")
        .single();

      if (newSession) setSessionId(newSession.id);
    };

    initSession();
  }, [user]);

  // Heartbeat: update last_activity every 5 min
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(async () => {
      await supabase
        .from("platform_admin_sessions")
        .update({ last_activity_at: new Date().toISOString() })
        .eq("id", sessionId);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const fetchSessions = useCallback(async (adminUserId?: string) => {
    const query = supabase
      .from("platform_admin_sessions")
      .select("*")
      .eq("is_active", true)
      .order("session_started_at", { ascending: false });

    if (adminUserId) {
      query.eq("admin_user_id", adminUserId);
    }

    const { data } = await query;
    setSessions((data || []) as AdminSession[]);
  }, []);

  const forceLogout = useCallback(async (targetSessionId: string) => {
    if (!user) return;
    await supabase
      .from("platform_admin_sessions")
      .update({
        is_active: false,
        expired_at: new Date().toISOString(),
        forced_logout_by: user.id,
      })
      .eq("id", targetSessionId);

    await supabase.from("admin_audit_log").insert({
      admin_user_id: user.id,
      action_type: "admin_session_forced_logout",
      details: { target_session_id: targetSessionId },
      user_agent: navigator.userAgent,
    });
  }, [user]);

  return { sessionId, sessions, fetchSessions, forceLogout };
}
