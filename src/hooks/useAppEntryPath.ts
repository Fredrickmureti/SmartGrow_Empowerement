/**
 * useAppEntryPath — resolves the correct entry URL for an app.
 *
 * Use this anywhere you'd otherwise hardcode `/hr/employees`, `/studio`,
 * etc. as a Link target. It returns:
 *
 *   - `/apps/{appId}/activate` when the app is not yet installed for
 *     the current org. The activate page is the single place that
 *     handles install / start-trial / subscribe / coming-soon.
 *   - `/{app.basePath}/{defaultModulePath}` when the app is installed,
 *     so the link drops the user straight into the workspace.
 *
 * This is what kills the "user lands in an empty workspace and is
 * separately told to install" UX bug — every cross-app link routes
 * through the same lifecycle the marketplace uses.
 */
import { useCallback } from "react";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { getAppById } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

function resolveWorkspacePath(app: AppDefinition): string {
  const defaultModule = app.defaultModule
    ? app.modules.find((m) => m.id === app.defaultModule)
    : app.modules[0];
  return `${app.basePath}${defaultModule?.path || ""}`;
}

export function useAppEntryPath() {
  const { isInstalled } = useInstalledApps();

  /**
   * Resolve the entry URL for a given appId. Returns `/apps` if the appId
   * is unknown so the caller never gets a dead link.
   */
  const getEntryPath = useCallback(
    (appId: string): string => {
      const app = getAppById(appId);
      if (!app) return "/apps";
      // Platform apps (e.g. Settings) are always "installed" — never gate them.
      if (app.isPlatform) return resolveWorkspacePath(app);
      if (isInstalled(app.id)) return resolveWorkspacePath(app);
      return `/apps/${app.id}/activate`;
    },
    [isInstalled],
  );

  return { getEntryPath };
}
