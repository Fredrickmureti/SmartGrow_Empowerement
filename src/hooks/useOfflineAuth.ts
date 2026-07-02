/**
 * Hook for offline authentication in Electron desktop app
 */

import { useState, useEffect, useCallback } from "react";
import { User, Session } from "@supabase/supabase-js";
import { offlineAuthService } from "@/services/offline/OfflineAuthService";
import { extendedOfflineStorage } from "@/services/offline/ExtendedOfflineStorage";
import { syncManager } from "@/services/offline";
import { backgroundSyncManager } from "@/services/offline/BackgroundSyncManager";
import { supabase } from "@/integrations/supabase/client";

interface OfflineAuthState {
  isOfflineMode: boolean;
  isElectron: boolean;
  canLoginOffline: boolean;
  cachedEmail: string | null;
  offlineUser: User | null;
}

export function useOfflineAuth() {
  const [state, setState] = useState<OfflineAuthState>({
    isOfflineMode: false,
    isElectron: false,
    canLoginOffline: false,
    cachedEmail: null,
    offlineUser: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  // Initialize offline auth state
  useEffect(() => {
    const init = async () => {
      const isElectron = offlineAuthService.isElectronApp();
      const canLoginOffline = await offlineAuthService.isOfflineLoginAvailable();
      const cachedEmail = await offlineAuthService.getCachedEmail();

      setState((prev) => ({
        ...prev,
        isElectron,
        canLoginOffline,
        cachedEmail,
      }));

      setIsLoading(false);
    };

    init();
  }, []);

  /**
   * Handle successful online login - cache credentials and data
   */
  const handleOnlineLoginSuccess = useCallback(
    async (email: string, password: string, session: Session) => {
      if (!offlineAuthService.isElectronApp()) return;

      try {
        // Cache credentials for offline login
        await offlineAuthService.cacheCredentials(
          email,
          password,
          session.user.id
        );

        // Cache session
        await offlineAuthService.cacheSession(session);

        // Get and cache user profile data
        const { data: userRoles } = await supabase
          .from("user_roles")
          .select("organization_id, role")
          .eq("user_id", session.user.id)
          .eq("is_active", true)
          .single();

        if (userRoles) {
          await offlineAuthService.cacheUserProfile({
            id: session.user.id,
            email: session.user.email || "",
            fullName: session.user.user_metadata?.full_name || "",
            organizationId: userRoles.organization_id,
            role: userRoles.role,
            permissions: [], // Could fetch from permissions table if needed
          });

          // Cache organization data for offline use
          await extendedOfflineStorage.cacheAllData(userRoles.organization_id);

          // Initialize product and customer cache
          await syncManager.initialize(userRoles.organization_id);
        }

        // Start background sync
        backgroundSyncManager.start();

        console.log("Offline data cached successfully");
      } catch (error) {
        console.error("Failed to cache offline data:", error);
      }
    },
    []
  );

  /**
   * Attempt offline login
   */
  const loginOffline = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!offlineAuthService.isElectronApp()) {
        return {
          success: false,
          error:
            "We couldn't reach the server and offline login is not available in this build. Check your internet connection and try again.",
        };
      }

      const result = await offlineAuthService.verifyOfflineCredentials(
        email,
        password
      );

      if (!result.valid) {
        return { success: false, error: "Invalid credentials" };
      }

      // Create offline user
      const offlineUser = await offlineAuthService.createOfflineUser();

      if (!offlineUser) {
        return {
          success: false,
          error:
            "No cached session is available on this device. Sign in once while online to enable offline mode.",
        };
      }

      setState((prev) => ({
        ...prev,
        isOfflineMode: true,
        offlineUser,
      }));

      // Start background sync (will sync when online)
      backgroundSyncManager.start();

      return { success: true };
    },
    []
  );

  /**
   * Handle logout - optionally clear cached data
   */
  const handleLogout = useCallback(async (clearCache = false) => {
    // Stop background sync
    backgroundSyncManager.stop();

    if (clearCache) {
      await offlineAuthService.clearAll();
    }

    setState((prev) => ({
      ...prev,
      isOfflineMode: false,
      offlineUser: null,
      canLoginOffline: !clearCache && prev.canLoginOffline,
    }));
  }, []);

  /**
   * Check if currently in offline mode
   */
  const checkOfflineMode = useCallback((): boolean => {
    return state.isOfflineMode;
  }, [state.isOfflineMode]);

  /**
   * Get cached organization ID for offline mode
   */
  const getOfflineOrganizationId = useCallback(async (): Promise<string | null> => {
    const profile = await offlineAuthService.getCachedUserProfile();
    return profile?.organizationId || null;
  }, []);

  return {
    ...state,
    isLoading,
    handleOnlineLoginSuccess,
    loginOffline,
    handleLogout,
    checkOfflineMode,
    getOfflineOrganizationId,
  };
}
