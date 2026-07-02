/**
 * Navigation Mode Context (DEPRECATED)
 * 
 * This context is deprecated. The app now uses AppAwareSidebar exclusively.
 * Kept for backwards compatibility during migration.
 * 
 * @deprecated Use AppAwareSidebar navigation directly
 */

import { createContext, useContext, ReactNode } from "react";

export type NavigationMode = "apps";

interface NavigationModeContextValue {
  mode: NavigationMode;
  setMode: (mode: NavigationMode) => void;
  toggleMode: () => void;
  isAppsMode: boolean;
  isLegacyMode: boolean;
}

const NavigationModeContext = createContext<NavigationModeContextValue>({
  mode: "apps",
  setMode: () => {},
  toggleMode: () => {},
  isAppsMode: true,
  isLegacyMode: false,
});

interface NavigationModeProviderProps {
  children: ReactNode;
}

/**
 * @deprecated Navigation mode is now always "apps"
 */
export function NavigationModeProvider({ children }: NavigationModeProviderProps) {
  const value: NavigationModeContextValue = {
    mode: "apps",
    setMode: () => {},
    toggleMode: () => {},
    isAppsMode: true,
    isLegacyMode: false,
  };

  return (
    <NavigationModeContext.Provider value={value}>
      {children}
    </NavigationModeContext.Provider>
  );
}

/**
 * @deprecated Navigation mode is now always "apps"
 */
export function useNavigationMode(): NavigationModeContextValue {
  const context = useContext(NavigationModeContext);
  return context;
}
