/**
 * App Registry Types
 * 
 * Defines the structure for the Odoo-style app navigation system.
 * Each app represents a major functional domain (Finance, Sales, etc.)
 * with its own modules/pages and access control.
 */

import { LucideIcon } from "lucide-react";
import { Permission } from "@/lib/permissions";

/**
 * Module definition - represents a single page/feature within an app
 */
export interface ModuleDefinition {
  /** Unique identifier for the module */
  id: string;
  /** Display name shown in navigation */
  name: string;
  /** Route path relative to app's basePath (e.g., "/invoices") */
  path: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Permission required to access this module (optional) */
  permission?: Permission;
  /** Badge text to show (e.g., "New", "Beta") */
  badge?: string;
  /** Whether this module is hidden from navigation but still accessible */
  hidden?: boolean;
  /** Description for tooltips/help */
  description?: string;
  /** Feature flag key for conditional visibility based on settings (e.g., "restaurant_mode") */
  featureFlag?: string;
}

/**
 * App definition - represents a major functional domain
 */
export interface AppDefinition {
  /** Unique identifier for the app */
  id: string;
  /** Display name shown in app switcher and navigation */
  name: string;
  /** Brief description of the app's purpose */
  description: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Brand color for the app (used in app switcher and headers) */
  color: string;
  /** Base URL path for the app (e.g., "/finance") */
  basePath: string;
  /** Permissions required to see/access this app (user needs ANY of these) */
  requiredPermissions: Permission[];
  /** Modules/pages within this app */
  modules: ModuleDefinition[];
  /** Default module to redirect to when accessing app root */
  defaultModule?: string;
  /** Whether this app is always available (system apps: Home, My Workspace, Settings) */
  alwaysAvailable?: boolean;
  /** Sort order for display in app switcher */
  sortOrder?: number;
  /**
   * Whether this app is restricted to internal users only.
   * Portal users are automatically blocked from apps with internalOnly: true.
   * This enforces Odoo's design: business apps (Finance, Sales, etc.) are
   * never accessible to portal users, regardless of permission grants.
   */
  internalOnly?: boolean;
  /**
   * Whether this app is a configuration/integration module (not a collaborative workspace).
   * Configuration apps skip the "Invite Your Team" step during onboarding since
   * there is nothing to collaborate on — they are infrastructure, not workspaces.
   * Examples: SMS/Twilio integration, payment gateways, email providers.
   */
  isConfigurationApp?: boolean;
  /**
   * Other app IDs this app depends on. Installing this app silently
   * auto-installs the dependencies; uninstalling a dependency is blocked
   * while any dependent app is still installed. Mirrors Odoo's module
   * dependency declaration (e.g., `hr_payroll` depends on `hr`).
   */
  dependsOn?: string[];
  /**
   * App is announced but not shippable yet. Marketplace shows it as a disabled
   * "Coming soon" tile instead of an installable card. AppSwitcher hides it.
   */
  comingSoon?: boolean;
  /**
   * When true, the AppTopNavbar suppresses the app-switcher grid icon and
   * the "Switch App / Back to Home" entries. Used for shells like My
   * Workspace where the user only ever sees one app and switching is not
   * meaningful.
   */
  hideAppSwitcher?: boolean;
}


/**
 * App navigation state - tracks user's current position
 */
export interface AppNavigationState {
  /** Currently active app ID */
  currentAppId: string | null;
  /** Currently active module ID within the app */
  currentModuleId: string | null;
  /** Last visited module per app (for smart defaults) */
  lastModuleByApp: Record<string, string>;
}

/**
 * User app preferences - stored in database
 */
export interface UserAppPreferences {
  /** User ID */
  userId: string;
  /** Organization ID */
  organizationId: string;
  /** Pinned apps shown in quick access */
  pinnedApps: string[];
  /** Last visited app */
  lastApp: string | null;
  /** Collapsed state for sidebar groups */
  collapsedGroups: string[];
}

/**
 * App access result - computed from permissions and entitlements
 */
export interface AppAccessResult {
  /** Whether the app is accessible */
  hasAccess: boolean;
  /** Reason for denial (if not accessible) */
  denialReason?: "permission" | "subscription" | "disabled";
  /** Whether access is read-only */
  isReadOnly: boolean;
  /** Accessible modules within the app */
  accessibleModules: ModuleDefinition[];
}

/**
 * Grouped apps for display in app switcher
 */
export interface AppGroup {
  /** Group label (e.g., "Core", "Operations", "Platform") */
  label: string;
  /** Apps in this group */
  apps: AppDefinition[];
}
