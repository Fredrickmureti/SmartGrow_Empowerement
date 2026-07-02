/**
 * Inactivity Monitor Hook
 * Tracks user activity and performs FULL SIGN-OUT after configurable timeout.
 * 
 * SECURITY MODEL:
 * - On timeout: calls supabase.auth.signOut() — session is truly destroyed
 * - Redirects to /login — user must re-authenticate with password or PIN
 * - No client-side lock state — nothing to bypass via DevTools
 * - Only enables when user has set an inactivity timeout in preferences
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'mousedown'] as const;
const THROTTLE_MS = 10_000;

export function useInactivityMonitor() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const lastActivityRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const throttleRef = useRef(0);
  const signingOutRef = useRef(false);

  // Fetch user's inactivity timeout preference
  const { data: preferences } = useQuery({
    queryKey: ['user-security-preferences-timeout', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await (supabase as any)
        .from('user_security_preferences')
        .select('inactivity_timeout_minutes')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) {
        console.error('Error fetching security preferences:', error);
        return null;
      }
      return data as { inactivity_timeout_minutes: number | null } | null;
    },
    enabled: !!user,
  });

  // Platform-wide fallback when the user has no personal preference. This
  // is the same row that the AdminSettings → Security tab edits.
  // Gated on `!!user` so anonymous visitors on /, /login, /signup never
  // hit platform_settings (which is platform-admin only and surfaces a
  // noisy "permission denied for function is_platform_admin" otherwise).
  const { data: platformTimeout } = useQuery({
    queryKey: ['platform-session-timeout-minutes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('platform_settings')
        .select('setting_value')
        .eq('setting_key', 'session_timeout_minutes')
        .maybeSingle();
      if (error) {
        console.error('Error fetching platform session timeout:', error);
        return null;
      }
      const raw = data?.setting_value;
      const parsed = raw ? Number(raw) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });


  const timeoutMinutes =
    preferences?.inactivity_timeout_minutes ?? platformTimeout ?? 120;
  const isEnabled = !!user && timeoutMinutes > 0;

  // Handle timeout: full sign-out, passing email for PIN pre-fill
  const handleTimeout = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;

    // Capture email before sign-out destroys the session
    const userEmail = user?.email ?? null;

    toast({
      title: 'Session expired',
      description: 'You were signed out due to inactivity.',
    });

    await signOut();
    navigate('/login', { replace: true, state: { email: userEmail, fromTimeout: true } });
    signingOutRef.current = false;
  }, [user?.email, signOut, navigate, toast]);

  // Activity tracking (throttled)
  const resetActivity = useCallback(() => {
    const now = Date.now();
    if (now - throttleRef.current < THROTTLE_MS) return;
    throttleRef.current = now;
    lastActivityRef.current = now;
  }, []);

  // Activity event listeners
  useEffect(() => {
    if (!isEnabled) return;
    ACTIVITY_EVENTS.forEach(event => {
      window.addEventListener(event, resetActivity, { passive: true });
    });
    return () => {
      ACTIVITY_EVENTS.forEach(event => {
        window.removeEventListener(event, resetActivity);
      });
    };
  }, [isEnabled, resetActivity]);

  // Periodic check interval
  useEffect(() => {
    if (!isEnabled) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    const timeoutMs = timeoutMinutes! * 60 * 1000;
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        handleTimeout();
      }
    }, 5000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isEnabled, timeoutMinutes, handleTimeout]);

  // Reset on user change
  useEffect(() => {
    lastActivityRef.current = Date.now();
    signingOutRef.current = false;
  }, [user?.id]);

  return {
    isEnabled,
    timeoutMinutes,
  };
}
