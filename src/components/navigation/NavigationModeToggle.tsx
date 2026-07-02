/**
 * Navigation Mode Toggle Component (DEPRECATED)
 * 
 * This component is deprecated and no longer renders anything.
 * The app now uses AppAwareSidebar navigation exclusively.
 * 
 * @deprecated Navigation mode toggle is no longer needed
 */

interface NavigationModeToggleProps {
  collapsed?: boolean;
}

/**
 * @deprecated No longer renders anything - apps mode is now the only navigation mode
 */
export function NavigationModeToggle({ collapsed = false }: NavigationModeToggleProps) {
  // No longer needed - return null
  return null;
}
