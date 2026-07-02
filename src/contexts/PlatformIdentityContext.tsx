/**
 * PlatformIdentityContext
 *
 * Single source of truth for "is the current auth user a platform admin?".
 *
 * Why this exists:
 *   Every guard (`ProtectedRoute`, `AdminProtectedRoute`, `RedirectIfAuthenticated`,
 *   `AdminAuthOnlyRoute`) used to issue its own `select id, role from platform_admins`
 *   query independently. That meant N redundant Supabase calls per page-load and a
 *   tiny race-window where one guard saw "not admin" while another already saw
 *   "admin" — flicker.
 *
 *   This provider issues the lookup ONCE per signed-in user and exposes the
 *   cached result. `usePlatformAdmin` is now a thin reader of this context.
 */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { PlatformAdminRole } from "@/hooks/usePlatformPermissions";

interface PlatformIdentityValue {
  isPlatformAdmin: boolean;
  platformRole: PlatformAdminRole | null;
  isChecking: boolean;
  refresh: () => Promise<void>;
}

const PlatformIdentityContext = createContext<PlatformIdentityValue | null>(null);

export function PlatformIdentityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [platformRole, setPlatformRole] = useState<PlatformAdminRole | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  // Sentinel `undefined` (vs `null` which is a valid "logged out" value) so
  // the first effect run ALWAYS triggers `check()`. Without this, an
  // incognito visitor (user === null) matched the initial ref (null) and
  // `check()` never ran, leaving `isChecking=true` forever — which froze
  // every admin guard on a "Verifying admin access..." spinner.
  const lastUserIdRef = useRef<string | null | undefined>(undefined);

  const check = useCallback(async () => {
    if (!user) {
      setIsPlatformAdmin(false);
      setPlatformRole(null);
      setIsChecking(false);
      return;
    }
    setIsChecking(true);
    try {
      const { data, error } = await supabase
        .from("platform_admins")
        .select("id, role")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();

      if (error) {
        console.error("[PlatformIdentity] lookup failed:", error);
        setIsPlatformAdmin(false);
        setPlatformRole(null);
      } else {
        setIsPlatformAdmin(!!data);
        setPlatformRole(
          data ? ((data.role as PlatformAdminRole) ?? "admin") : null,
        );
      }
    } catch (err) {
      console.error("[PlatformIdentity] unexpected error:", err);
      setIsPlatformAdmin(false);
      setPlatformRole(null);
    } finally {
      setIsChecking(false);
    }
  }, [user]);

  useEffect(() => {
    const userId = user?.id ?? null;
    if (lastUserIdRef.current === userId) return;
    lastUserIdRef.current = userId;
    check();
  }, [user, check]);

  return (
    <PlatformIdentityContext.Provider
      value={{ isPlatformAdmin, platformRole, isChecking, refresh: check }}
    >
      {children}
    </PlatformIdentityContext.Provider>
  );
}

export function usePlatformIdentity(): PlatformIdentityValue {
  const ctx = useContext(PlatformIdentityContext);
  if (!ctx) {
    // Safe fallback: behave as "not admin, not checking" if the provider is
    // missing. This keeps storybook / test renders from crashing while still
    // making the missing provider obvious in dev.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[PlatformIdentity] usePlatformIdentity called outside PlatformIdentityProvider",
      );
    }
    return {
      isPlatformAdmin: false,
      platformRole: null,
      isChecking: false,
      refresh: async () => {},
    };
  }
  return ctx;
}