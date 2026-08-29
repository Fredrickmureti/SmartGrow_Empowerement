/**
 * useInstalledApps — single-institution build (Smart Grow Empowerment).
 *
 * The SaaS app-marketplace / per-organization installation model has been
 * retired. This is a single-company Microfinance deployment: every app that
 * ships in the registry is available to the institution, always. The hook is
 * kept (same shape) so existing navigation, command palette, dashboard and
 * settings surfaces continue to work without a sweeping rewrite; it now
 * resolves synchronously from the local registry with no database access.
 *
 * Install/uninstall mutations are intentionally no-ops — module availability
 * is a deployment decision, not a runtime tenant purchase.
 */

import { useCallback, useMemo } from "react";
import { APP_REGISTRY } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

export interface InstalledApp {
  id: string;
  organization_id: string;
  app_id: string;
  installed_at: string;
  installed_by: string | null;
  is_active: boolean;
  settings: Record<string, unknown>;
  last_accessed_at: string | null;
}

interface UseInstalledAppsResult {
  installedApps: InstalledApp[];
  installedAppIds: Set<string>;
  isLoading: boolean;
  isError: boolean;
  isReady: boolean;
  hasInitialSnapshot: boolean;

  isInstalled: (appId: string) => boolean;
  canUninstall: (appId: string) => boolean;
  getInstalledApp: (appId: string) => InstalledApp | undefined;

  installApp: (appId: string) => Promise<void>;
  uninstallApp: (appId: string) => Promise<void>;
  updateAppSettings: (appId: string, settings: Record<string, unknown>) => Promise<void>;
  trackAppAccess: (appId: string) => void;

  installApps: (appIds: string[]) => Promise<void>;

  getAvailableAppsToInstall: () => AppDefinition[];
}

const INSTALLED_AT = "1970-01-01T00:00:00.000Z";

const ALL_APPS: AppDefinition[] = Object.values(APP_REGISTRY) as AppDefinition[];

const ALL_INSTALLED: InstalledApp[] = ALL_APPS.map((app) => ({
  id: `builtin:${app.id}`,
  organization_id: "institution",
  app_id: app.id,
  installed_at: INSTALLED_AT,
  installed_by: null,
  is_active: true,
  settings: {},
  last_accessed_at: null,
}));

const ALL_INSTALLED_IDS = new Set(ALL_INSTALLED.map((row) => row.app_id));

export function useInstalledApps(): UseInstalledAppsResult {
  const isInstalled = useCallback(() => true, []);
  const canUninstall = useCallback(() => false, []);
  const getInstalledApp = useCallback(
    (appId: string) => ALL_INSTALLED.find((row) => row.app_id === appId),
    [],
  );
  const noop = useCallback(async () => {}, []);
  const trackAppAccess = useCallback(() => {}, []);
  const getAvailableAppsToInstall = useCallback(() => [], []);

  return useMemo(
    () => ({
      installedApps: ALL_INSTALLED,
      installedAppIds: ALL_INSTALLED_IDS,
      isLoading: false,
      isError: false,
      isReady: true,
      hasInitialSnapshot: true,
      isInstalled,
      canUninstall,
      getInstalledApp,
      installApp: noop,
      uninstallApp: noop,
      updateAppSettings: noop,
      trackAppAccess,
      installApps: noop,
      getAvailableAppsToInstall,
    }),
    [isInstalled, canUninstall, getInstalledApp, noop, trackAppAccess, getAvailableAppsToInstall],
  );
}
