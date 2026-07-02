import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type PlatformAdminRole = "owner" | "admin" | "operator";

export interface PlatformPermissions {
  role: PlatformAdminRole | null;
  permissions: Set<string>;
  countryScopes: string[];
  isLoading: boolean;
  isPlatformAdmin: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isOperator: boolean;
  isGlobalAccess: boolean;
  hasPerm: (key: string) => boolean;
  hasAnyPerm: (keys: string[]) => boolean;
  hasCountryScope: (countryCode: string) => boolean;
  refresh: () => Promise<void>;
}

// All platform permission keys
export const PLATFORM_PERMISSION_KEYS = [
  "organizations.view", "organizations.manage",
  "billing.view", "billing.manage",
  "users.view", "users.manage",
  "settings.view", "settings.manage",
  "analytics.view", "reports.view",
  "localization.manage", "email.manage",
  "audit_log.view", "plans.manage",
  "infrastructure.manage", "demo_requests.manage",
  "team.view", "team.manage",
] as const;

export type PlatformPermissionKey = typeof PLATFORM_PERMISSION_KEYS[number];

export function usePlatformPermissions(): PlatformPermissions {
  const { user } = useAuth();
  const [role, setRole] = useState<PlatformAdminRole | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [countryScopes, setCountryScopes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const lastUserIdRef = useRef<string | null>(null);

  const fetchPermissions = useCallback(async () => {
    if (!user) {
      setRole(null);
      setPermissions(new Set());
      setIsLoading(false);
      return;
    }

    try {
      // Fetch role, permissions, and country scopes in parallel
      const [roleRes, permRes, scopeRes] = await Promise.all([
        supabase.rpc("get_platform_admin_role", { _user_id: user.id }),
        supabase.rpc("get_platform_admin_permissions", { _user_id: user.id }),
        supabase.rpc("get_platform_admin_scopes", { _user_id: user.id }),
      ]);

      setRole((roleRes.data as PlatformAdminRole) || null);
      setPermissions(new Set((permRes.data as string[]) || []));
      setCountryScopes((scopeRes.data as string[]) || []);
    } catch (err) {
      console.error("Error fetching platform permissions:", err);
      setRole(null);
      setPermissions(new Set());
      setCountryScopes([]);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const userId = user?.id ?? null;
    if (lastUserIdRef.current !== userId) {
      lastUserIdRef.current = userId;
      setIsLoading(true);
      fetchPermissions();
    }
  }, [user, fetchPermissions]);

  return useMemo(() => {
    const isPlatformAdmin = role !== null;
    const isOwner = role === "owner";
    const isGlobalAccess = isOwner || role === "admin";

    const hasPerm = (key: string): boolean => {
      if (isOwner) return true;
      return permissions.has(key);
    };

    const hasAnyPerm = (keys: string[]): boolean => {
      return keys.some(k => hasPerm(k));
    };

    const hasCountryScope = (countryCode: string): boolean => {
      if (isGlobalAccess) return true;
      return countryScopes.includes(countryCode);
    };

    return {
      role,
      permissions,
      countryScopes,
      isLoading,
      isPlatformAdmin,
      isOwner,
      isAdmin: role === "admin",
      isOperator: role === "operator",
      isGlobalAccess,
      hasPerm,
      hasAnyPerm,
      hasCountryScope,
      refresh: fetchPermissions,
    };
  }, [role, permissions, countryScopes, isLoading, fetchPermissions]);
}
