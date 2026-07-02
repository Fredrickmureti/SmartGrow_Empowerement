/**
 * Shared shell primitives for /hr/configuration/* sub-pages.
 *
 * Wave J: replaces the bespoke `SectionHeader` exported out of
 * OnboardingTemplatesPage and the now-removed sticky sidebar. Every
 * sub-page renders the same header pattern so the configuration area
 * matches Attendance and the rest of the platform.
 */
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { ReactNode } from "react";

interface ConfigPageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /** When true, hides the "Back to Configuration" link (used by the Overview page itself). */
  hideBack?: boolean;
}

/**
 * Standard header for a configuration sub-page. Mirrors the platform
 * `page-header` / `page-title` pattern used by Attendance Settings,
 * Departments, Employees, etc.
 */
export function ConfigPageHeader({
  title,
  subtitle,
  action,
  hideBack = false,
}: ConfigPageHeaderProps) {
  return (
    <div className="space-y-2">
      {!hideBack && (
        <Link
          to="/hr/configuration"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Configuration
        </Link>
      )}
      <div className="page-header">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="action-buttons">{action}</div>}
      </div>
    </div>
  );
}
