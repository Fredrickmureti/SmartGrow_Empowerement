/**
 * Navigation Mode Hook (DEPRECATED)
 * 
 * This hook is deprecated. The app now uses AppAwareSidebar exclusively.
 * Kept for backwards compatibility during migration.
 * 
 * @deprecated Use AppAwareSidebar navigation directly
 */

export type NavigationMode = "apps";

/**
 * @deprecated Navigation mode is now always "apps"
 */
export function useNavigationMode() {
  return {
    mode: "apps" as NavigationMode,
    setMode: () => {},
    toggleMode: () => {},
    isAppsMode: true,
    isLegacyMode: false,
  };
}
