/**
 * ReportSwitcherStrip — first-class report switching inside the reporting
 * workspace.
 *
 * A user working in a reporting domain (Finance, Payroll, Inventory, …) should
 * not have to walk back through the library to open the next report. This strip
 * lists the sibling reports of the active domain, plus the semantically related
 * reports from other domains, and carries the current reporting scope
 * (period / branch / grouping / …) forward on every jump.
 *
 * Everything it renders comes from `ReportRegistry` — no page declares its own
 * sibling list, so a new registry entry appears here automatically. Entries the
 * user has no permission for are filtered out, so the strip never advertises a
 * report that would bounce them.
 */

import { Link, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import {
  REPORT_DOMAIN_LABELS,
  findReportByPath,
  getRelatedReports,
  getReportDomain,
  getReportsByDomain,
  type ReportDefinition,
} from "@/services/reports/ReportRegistry";
import { resolveReportPath } from "@/services/reports/reportsNav";

function reportHref(def: ReportDefinition, scopeSearch: string, pathname: string) {
  // ADR 0143 — inventory reports are mounted in both the Finance and the
  // Inventory shell; keep the user in the shell they are already in.
  const resolved = resolveReportPath(def, pathname);
  const [base, ownSearch] = resolved.split("?");
  if (!scopeSearch) return resolved;
  // The registry path may already deep-link into a tab (`?view=pnl`). Keep it
  // and append the inherited reporting scope.
  const inherited = scopeSearch.replace(/^\?/, "");
  return ownSearch ? `${base}?${ownSearch}&${inherited}` : `${base}?${inherited}`;
}

export function ReportSwitcherStrip() {
  const { pathname } = useLocation();
  const { can } = usePermissions();
  const { toReportSearch } = useReportWorkspaceState();

  const active = findReportByPath(pathname);
  if (!active) return null;

  const domain = getReportDomain(active);
  const scopeSearch = toReportSearch();

  const allowed = (def: ReportDefinition) =>
    !def.permission || can(def.permission);

  // Child leaves (`parentId`) are tab deep-links of another report; the strip
  // lists reports, not tabs.
  const siblings = getReportsByDomain(domain).filter(
    (r) => !r.parentId && allowed(r),
  );
  const related = getRelatedReports(active.id).filter(
    (r) => getReportDomain(r) !== domain && allowed(r),
  );

  if (siblings.length <= 1 && related.length === 0) return null;

  return (
    <nav
      aria-label={`${REPORT_DOMAIN_LABELS[domain]} reports`}
      className="rounded-lg border bg-muted/30"
    >
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {REPORT_DOMAIN_LABELS[domain]}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="flex items-center gap-1">
          {siblings.map((r) => {
            const isActive = r.id === active.id;
            return (
              <Link
                key={r.id}
                to={reportHref(r, scopeSearch, pathname)}
                aria-current={isActive ? "page" : undefined}
                title={r.description}
                className={cn(
                  "whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {r.name}
              </Link>
            );
          })}
        </div>
      </div>

      {related.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto border-t px-3 py-2">
          <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Related
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <div className="flex items-center gap-1">
            {related.map((r) => (
              <Link
                key={r.id}
                to={reportHref(r, scopeSearch, pathname)}
                title={`${r.description} · ${REPORT_DOMAIN_LABELS[getReportDomain(r)]}`}
                className="whitespace-nowrap rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
              >
                {r.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

export default ReportSwitcherStrip;
