/**
 * Shared shell primitives for /hr/configuration/* sub-pages.
 *
 * Wraps the design-system `PageHeader` primitive and adds a
 * "← Configuration" eyebrow link so every configuration sub-page reads
 * the same as Employees, Departments, Job Positions, and Work Locations
 * (all of which now use `PageHeader` directly).
 */
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { ReactNode } from "react";
import { PageHeader } from "@/design-system";

interface ConfigPageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /** When true, hides the "Back to Configuration" link (used by the Overview page itself). */
  hideBack?: boolean;
}

export function ConfigPageHeader({
  title,
  subtitle,
  action,
  hideBack = false,
}: ConfigPageHeaderProps) {
  return (
    <PageHeader
      eyebrow={
        hideBack ? undefined : (
          <Link
            to="/hr/configuration"
            className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Configuration
          </Link>
        )
      }
      title={title}
      description={subtitle}
      actions={action}
    />
  );
}
