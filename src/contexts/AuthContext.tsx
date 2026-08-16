import { createContext, useContext, useEffect, useState, ReactNode, useRef, useCallback } from "react";
import { User, Session, AuthChangeEvent } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { setSentryUser } from "@/lib/sentry";
import { getDeviceInfo } from "@/services/security/DeviceFingerprintService";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isOfflineMode: boolean;
  isEmailVerified: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; user: User | null }>;
  signOut: () => Promise<void>;
  resendConfirmation: (email: string) => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const initializedRef = useRef(false);
  // Keep track of current user ID to prevent unnecessary re-renders
  const currentUserIdRef = useRef<string | null>(null);

  // Memoized function to update auth state only when necessary
  const updateAuthState = useCallback((newSession: Session | null, event?: AuthChangeEvent) => {
    const newUserId = newSession?.user?.id ?? null;
    
    // Only update state if the user actually changed (different user or sign out)
    // Don't update on TOKEN_REFRESHED if user ID is the same
    if (event === 'TOKEN_REFRESHED' && currentUserIdRef.current === newUserId) {
      // Token refresh for same user - just update session silently without triggering re-renders
      return;
    }

    // Same user, new session object (supabase-js re-emits SIGNED_IN when the
    // tab regains visibility and it recovers/refreshes the stored session).
    // Emitting a NEW `user` object reference here is what made every
    // downstream context that depends on `user` (BranchContext, POS shells,
    // workspace gates) re-run its fetch effect and flip back to a loading
    // state — the "switching tabs reloads the app" symptom. Keep the same
    // `user` identity and only swap the session.
    if (newUserId && currentUserIdRef.current === newUserId) {
      setSession(newSession);
      return;
    }
    
    // Update the ref
    currentUserIdRef.current = newUserId;
    
    // Update state
    setSession(newSession);
    setUser(newSession?.user ?? null);
    
    
    // Update Sentry user context
    if (newSession?.user) {
      setSentryUser({
        id: newSession.user.id,
        email: newSession.user.email,
      });
    } else {
      setSentryUser(null);
    }
  }, []);

  useEffect(() => {
    // Prevent double initialization in React 18 Strict Mode
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Check for existing session first, gracefully handle stale tokens
    supabase.auth.getSession().then(async ({ data: { session }, error }) => {
      if (error || !session) {
        // Session retrieval failed or no session — clear any stale tokens
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch (_) {
          // Ignore signOut errors
        }
        currentUserIdRef.current = null;
        setSession(null);
        setUser(null);
        setIsLoading(false);
        return;
      }
      currentUserIdRef.current = session?.user?.id ?? null;
      setSession(session);
      setUser(session?.user ?? null);
      setIsLoading(false);
    }).catch(async () => {
      // Failed to get session - might be offline or stale refresh token
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch (_) {
        // Ignore
      }
      setIsLoading(false);
    });

    // Set up auth state listener for subsequent changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Skip initial session event - we already handled that above
        if (event === 'INITIAL_SESSION') {
          return;
        }

        // On sign-out, clear any in-flight onboarding idempotency key so the
        // next signup attempt in this tab gets a fresh one (prevents stale
        // keys colliding across separate users sharing a browser).
        if (event === 'SIGNED_OUT') {
          try {
            sessionStorage.removeItem('onboarding_idem_key');
          } catch (_) { /* ignore */ }
        }

        // Handle auth state changes intelligently
        updateAuthState(session, event);
      }
    );

    return () => subscription.unsubscribe();
  }, [updateAuthState]);

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      // Track device login on successful sign-in
      if (!error && data?.user) {
        trackDeviceLogin('password');
      }
      return { error, user: data?.user ?? null };
    } catch (err) {
      // Network-level failures (e.g. `TypeError: Failed to fetch` when
      // offline) bubble out of supabase-js instead of arriving via the
      // `{ error }` envelope. Surface them in the same shape so the UI
      // can normalize uniformly.
      const message = err instanceof Error ? err.message : 'Network error';
      const e = new Error(message);
      e.name = 'NetworkError';
      return { error: e, user: null };
    }
  };

  // Track device login after authentication
  const trackDeviceLogin = async (loginMethod: string = 'password') => {
    try {
      const deviceInfo = await getDeviceInfo();
      
      // Get geolocation (best-effort)
      let geoData: Record<string, any> = {};
      try {
        const geoResponse = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
        if (geoResponse.ok) {
          geoData = await geoResponse.json();
        }
      } catch (e) {
        console.log('Geolocation lookup skipped');
      }

      // Call RPC to record device login
      const { data, error } = await supabase.rpc('record_device_login', {
        p_device_fingerprint: deviceInfo.fingerprint,
        p_device_name: deviceInfo.deviceName,
        p_browser: deviceInfo.browser,
        p_browser_version: deviceInfo.browserVersion,
        p_os: deviceInfo.os,
        p_os_version: deviceInfo.osVersion,
        p_device_type: deviceInfo.deviceType,
        p_ip_address: geoData.ip || null,
        p_city: geoData.city || null,
        p_region: geoData.region || null,
        p_country: geoData.country_name || null,
        p_country_code: geoData.country_code || null,
        p_latitude: geoData.latitude || null,
        p_longitude: geoData.longitude || null,
        p_login_method: loginMethod,
        p_user_agent: deviceInfo.userAgent,
      });

      if (error) {
        console.warn('Device tracking failed:', error.message);
      } else if (data) {
        const result = data as Record<string, unknown>;
        if (result.is_new_device || result.is_new_location) {
          console.log('New device/location detected:', result);
        }
      }
    } catch (e) {
      console.warn('Device tracking error:', e);
    }
  };

  const resendConfirmation = async (email: string) => {
    // Single canonical verification landing zone — must match SignupForm.
    // Splitting between /auth/callback and /onboarding-setup was causing
    // verified-link outcomes to be handled by two divergent code paths.
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    return { error };
  };

  const isEmailVerified = Boolean(user?.email_confirmed_at);

  const signOut = async () => {
    // Check if we're actually online before trying to sign out
    const isOnline = navigator.onLine;
    
    if (isOnline) {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.warn('Failed to sign out from server, clearing local state:', error);
        // If sign out fails due to network, still clear local state
      }
    }
    
    // Always clear local state regardless of network status
    setUser(null);
    setSession(null);
    currentUserIdRef.current = null;
    setIsOfflineMode(false);
    
    // Clear Sentry user context
    setSentryUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, isLoading, isOfflineMode, isEmailVerified, signIn, signOut, resendConfirmation }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
