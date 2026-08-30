/**
 * useAppNavigation Hook
 * 
 * Provides app navigation state and utilities for the Odoo-style app system.
 * Handles app switching, module navigation, and access control.
 * Now integrates with installed apps to filter available apps.
 */

import { useMemo, useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { usePermissions } from "@/hooks/usePermissions";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import {
  APP_REGISTRY,
  getAppById,
  getAppByPath,
  getModuleByPath,
  getAppGroups,
} from "@/lib/apps/registry";
import type { AppDefinition, ModuleDefinition, AppAccessResult, AppGroup } from "@/lib/apps/types";

// Apps that portal users (employees) may see — self-service surfaces of HR domain.
// After the HR split, the foundational Employees app + dependent HR apps remain accessible
// to portal users for self-service (My Profile, My Leave, My Payslips, etc.).
// The legacy 'hr' alias was removed: portal users now route to the canonical
// /me/* workspace; if any legacy data still references 'hr' it will be denied
// here, which is the intended terminal state.
const PORTAL_HR_APPS = new Set<string>([
  "employees",   // foundation
  "time-off",
  "attendance",
  "payroll",
  "recruitment",
]);

interface UseAppNavigationResult {
  // Current state
  currentApp: AppDefinition | null;
  currentModule: ModuleDefinition | null;
  
  // Available apps (filtered by access)
  availableApps: AppDefinition[];
  appGroups: AppGroup[];
  
  // Navigation helpers
  navigateToApp: (appId: string, moduleId?: string) => void;
  navigateToModule: (app: AppDefinition, moduleId: string) => void;
  
  // Access checking
  canAccessApp: (app: AppDefinition) => AppAccessResult;
  getAccessibleModules: (app: AppDefinition) => ModuleDefinition[];
  
  // Utility
  isAppActive: (appId: string) => boolean;
  isModuleActive: (app: AppDefinition, moduleId: string) => boolean;
  getAppUrl: (app: AppDefinition, moduleId?: string) => string;
}

export function useAppNavigation(): UseAppNavigationResult {
  const location = useLocation();
  const navigate = useNavigate();
  const { userType } = useSession();
  const permissions = usePermissions();
  const { isInstalled, trackAppAccess, installedAppIds } = useInstalledApps();
  const { hasAppAccess } = useAppAccess();

  // Determine current app from URL
  const currentApp = useMemo(() => {
    return getAppByPath(location.pathname);
  }, [location.pathname]);

  // Determine current module within the app
  const currentModule = useMemo(() => {
    if (!currentApp) return null;
    return getModuleByPath(currentApp, location.pathname) || null;
  }, [currentApp, location.pathname]);

  // Check if user can access an app
  const canAccessApp = useCallback((app: AppDefinition): AppAccessResult => {
    // My Workspace is always accessible — it's the personal shell that
    // any signed-in user can open. Permission-gated modules are still
    // filtered.
    if (app.id === "me") {
      const accessibleModules = app.modules.filter(m =>
        !m.permission || permissions.can(m.permission),
      );
      return { hasAccess: true, isReadOnly: false, accessibleModules };
    }

    // Portal users may only see apps explicitly opted into for self-service
    // (the HR-domain split apps + the legacy 'hr' alias). All other apps,
    // including any future ones marked internalOnly, are blocked outright —
    // closing the bypass that the legacy `app.id === 'hr'` special-case had.
    if (userType === "portal") {
      if (!PORTAL_HR_APPS.has(app.id)) {
        return {
          hasAccess: false,
          denialReason: "permission",
          isReadOnly: false,
          accessibleModules: [],
        };
      }
      // Portal user on a permitted HR app — must still be installed for the org
      if (!isInstalled(app.id)) {
        return {
          hasAccess: false,
          denialReason: "disabled",
          isReadOnly: false,
          accessibleModules: [],
        };
      }
      return {
        hasAccess: true,
        isReadOnly: false,
        accessibleModules: app.modules,
      };
    }

    // Every app that ships in the registry is available to the institution;
    // only apps that are not shippable yet (comingSoon) are withheld.
    if (!app.alwaysAvailable && !hasAppAccess(app.id)) {
      return {
        hasAccess: false,
        denialReason: "disabled",
        isReadOnly: false,
        accessibleModules: [],
      };
    }

    // Check permissions (user needs ANY of the required permissions)
    const hasPermission = app.requiredPermissions.length === 0 ||
      app.requiredPermissions.some(perm => permissions.can(perm));
    
    if (!hasPermission) {
      return {
        hasAccess: false,
        denialReason: "permission",
        isReadOnly: false,
        accessibleModules: [],
      };
    }

    // Get accessible modules
    const accessibleModules = app.modules.filter(module => {
      // Check module permission
      if (module.permission && !permissions.can(module.permission)) {
        return false;
      }
      return true;
    });

    // Check if any modules are accessible
    if (accessibleModules.length === 0) {
      return {
        hasAccess: false,
        denialReason: "permission",
        isReadOnly: false,
        accessibleModules: [],
      };
    }

    // Read-only is a role property (viewer), nothing else.
    const isReadOnlyAccess = permissions.isViewer;

    return {
      hasAccess: true,
      isReadOnly: isReadOnlyAccess,
      accessibleModules,
    };
  }, [hasAppAccess, permissions, userType, isInstalled]);

  // Get list of apps user can access (must be installed AND have access)
  // Portal users can ONLY see the HR app (self-service modules)
  const availableApps = useMemo(() => {
    return APP_REGISTRY.filter(app => {
      // My Workspace is its own dedicated shell — never appears in the
      // app switcher list.
      if (app.id === "me") return false;
      // Portal users: only HR-domain apps (self-service surface)
      if (userType === "portal" && !PORTAL_HR_APPS.has(app.id)) {
        return false;
      }
      // Must be installed (platform apps are always available)
      if (!app.alwaysAvailable && !isInstalled(app.id)) {
        return false;
      }
      // Must have access
      const access = canAccessApp(app);
      return access.hasAccess;
    }).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }, [canAccessApp, isInstalled, installedAppIds, userType]);

  // Group apps for display (only installed apps)
  const appGroups = useMemo((): AppGroup[] => {
    const allGroups = getAppGroups();
    
    // Filter each group to only include accessible AND installed apps
    return allGroups.map(group => ({
      ...group,
      apps: group.apps.filter(app => {
        if (userType === "portal" && !PORTAL_HR_APPS.has(app.id)) return false;
        if (!app.alwaysAvailable && !isInstalled(app.id)) return false;
        return canAccessApp(app).hasAccess;
      }),
    })).filter(group => group.apps.length > 0);
  }, [canAccessApp, isInstalled, installedAppIds, userType]);

  // Track app access when navigating
  useEffect(() => {
    if (currentApp && !currentApp.alwaysAvailable) {
      trackAppAccess(currentApp.id);
    }
  }, [currentApp?.id, trackAppAccess]);

  // Get accessible modules for an app
  const getAccessibleModules = useCallback((app: AppDefinition): ModuleDefinition[] => {
    return canAccessApp(app).accessibleModules;
  }, [canAccessApp]);

  // Navigate to an app (optionally to a specific module)
  const navigateToApp = useCallback((appId: string, moduleId?: string) => {
    const app = getAppById(appId);
    if (!app) {
      console.warn(`App not found: ${appId}`);
      return;
    }

    const access = canAccessApp(app);
    if (!access.hasAccess) {
      console.warn(`No access to app: ${appId}`);
      return;
    }

    // Determine which module to navigate to
    let targetModule = moduleId 
      ? app.modules.find(m => m.id === moduleId)
      : app.modules.find(m => m.id === app.defaultModule);

    // Fallback to first accessible module
    if (!targetModule || !access.accessibleModules.includes(targetModule)) {
      targetModule = access.accessibleModules[0];
    }

    if (!targetModule) {
      console.warn(`No accessible modules in app: ${appId}`);
      return;
    }

    const url = `${app.basePath}${targetModule.path}`;
    navigate(url);
  }, [canAccessApp, navigate]);

  // Navigate to a specific module within an app
  const navigateToModule = useCallback((app: AppDefinition, moduleId: string) => {
    const module = app.modules.find(m => m.id === moduleId);
    if (!module) {
      console.warn(`Module not found: ${moduleId} in app ${app.id}`);
      return;
    }

    const url = `${app.basePath}${module.path}`;
    navigate(url);
  }, [navigate]);

  // Check if an app is currently active
  const isAppActive = useCallback((appId: string): boolean => {
    return currentApp?.id === appId;
  }, [currentApp]);

  // Check if a module is currently active
  const isModuleActive = useCallback((app: AppDefinition, moduleId: string): boolean => {
    if (currentApp?.id !== app.id) return false;
    return currentModule?.id === moduleId;
  }, [currentApp, currentModule]);

  // Get URL for an app/module
  const getAppUrl = useCallback((app: AppDefinition, moduleId?: string): string => {
    const module = moduleId 
      ? app.modules.find(m => m.id === moduleId)
      : app.modules.find(m => m.id === app.defaultModule) || app.modules[0];
    
    return `${app.basePath}${module?.path || ""}`;
  }, []);

  return {
    currentApp,
    currentModule,
    availableApps,
    appGroups,
    navigateToApp,
    navigateToModule,
    canAccessApp,
    getAccessibleModules,
    isAppActive,
    isModuleActive,
    getAppUrl,
  };
}

/**
 * Hook to check if we're in "app mode" vs legacy navigation
 * Used during the transition period
 */
export function useIsAppMode(): boolean {
  const location = useLocation();
  
  // Check if the current path matches any app's base path
  const app = getAppByPath(location.pathname);
  return app !== undefined;
}
