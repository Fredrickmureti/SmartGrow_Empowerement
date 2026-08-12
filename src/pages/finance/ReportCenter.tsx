/**
 * Report Center — Unified hub for all accounting reports
 * 
 * Enhanced with:
 * - H1: Single canonical report center (no fragmented navigation)
 * - H2: Favorites, recent reports, saved views
 * - M1: Report scheduling access
 */

import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { useCallback } from "react";
import { useReportSavedViews } from "@/hooks/useReportSavedViews";
import { useReportViewLogger } from "@/hooks/reports/useReportViewLogger";
import { ReportSearchPalette } from "@/components/reports/ReportSearchPalette";
import {
  REPORT_REGISTRY,
  REPORT_CATEGORY_LABELS,
  REPORT_DOMAIN_LABELS,
  getReportDomain,
  getReportsByCategory,
  type ReportDefinition,
} from "@/services/reports/ReportRegistry";
import {
  FileText,
  ArrowRight,
  Star,
  StarOff,
  CalendarClock,
  History,
  Search,
  Layers,
} from "lucide-react";

// Per-category icon falls back to the first report's icon in that category.
function categoryIcon(reports: ReportDefinition[]) {
  return reports[0]?.icon ?? FileText;
}

// Default Quick Access set when the user hasn't favorited anything.
const DEFAULT_QUICK_ACCESS_IDS = [
  "profit-and-loss",
  "balance-sheet",
  "trial-balance",
  "general-ledger",
  "aged-receivables",
  "cash-flow",
];

export default function ReportCenter() {
  // Phase B0 — log Report Center index visits alongside per-report opens.
  useReportViewLogger("report-center");
  const navigate = useNavigate();
  // Library state lives in the URL, not in component state: the tab, the search
  // query and the domain filter are all part of "where the user was" and must
  // survive opening a report and pressing Back. Replacing history on every
  // keystroke keeps Back meaning "leave the library", not "undo one letter".
  const [params, setParams] = useSearchParams();
  const activeTab = params.get("tab") ?? "all";
  const searchQuery = params.get("q") ?? "";
  const domainFilter = params.get("domain") ?? "all";

  const setLibraryState = useCallback(
    (next: Record<string, string>, options?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (!value || value === "all") merged.delete(key);
            else merged.set(key, value);
          }
          return merged;
        },
        { replace: options?.replace ?? false },
      );
    },
    [setParams],
  );

  const {
    favorites,
    recentReports,
    views,
    isLoading: viewsLoading,
    toggleFavorite,
    saveView,
    deleteView,
    logReportAccess,
  } = useReportSavedViews();

  const allReports = REPORT_REGISTRY;
  const groupedAll = getReportsByCategory();
  // Build display categories from the registry; one section per category.
  const displayCategories = Array.from(groupedAll.entries()).map(([cat, reports]) => ({
    key: cat,
    title: REPORT_CATEGORY_LABELS[cat],
    icon: categoryIcon(reports),
    reports,
  }));

  const query = searchQuery.toLowerCase();
  const domainScoped = displayCategories
    .map(cat => ({
      ...cat,
      reports:
        domainFilter === "all"
          ? cat.reports
          : cat.reports.filter(r => getReportDomain(r) === domainFilter),
    }))
    .filter(cat => cat.reports.length > 0);
  const filteredCategories = searchQuery
    ? domainScoped
        .map(cat => ({
          ...cat,
          reports: cat.reports.filter(
            r =>
              r.name.toLowerCase().includes(query) ||
              r.description.toLowerCase().includes(query) ||
              r.keywords.some(k => k.includes(query))
          ),
        }))
        .filter(cat => cat.reports.length > 0)
    : domainScoped;

  const handleNavigate = (report: ReportDefinition) => {
    logReportAccess(report.reportType, report.path);
    navigate(report.path);
  };

  // Find favorite report items from saved views (match by reportType — first match wins).
  const favoriteReports = favorites
    .map(fav => {
      const report = allReports.find(r => r.reportType === fav.report_type);
      return report ? { ...report, savedViewId: fav.id } : null;
    })
    .filter(Boolean) as (ReportDefinition & { savedViewId: string })[];

  // Map recent access log to report items (prefer exact path match, fall back to type).
  const recentReportItems = recentReports
    .map(entry => {
      const report =
        allReports.find(r => r.path === entry.report_path) ??
        allReports.find(r => r.reportType === entry.report_type);
      return report ? { ...report, accessedAt: entry.accessed_at } : null;
    })
    .filter(Boolean) as (ReportDefinition & { accessedAt: string })[];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="page-title">Report Center</h1>
          <p className="text-muted-foreground">
            {allReports.length} reports available across {displayCategories.length} categories
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate("/studio/scheduling")}
          className="gap-2"
        >
          <CalendarClock className="h-4 w-4" />
          Schedule Reports
        </Button>
      </div>

      {/* Tabs: All / Favorites / Recent */}
      <Tabs value={activeTab} onValueChange={(tab) => setLibraryState({ tab })}>
        <TabsList>
          <TabsTrigger value="all" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            All Reports
          </TabsTrigger>
          <TabsTrigger value="favorites" className="gap-1.5">
            <Star className="h-3.5 w-3.5" />
            Favorites
            {favorites.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs h-5 px-1.5">
                {favorites.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="recent" className="gap-1.5">
            <History className="h-3.5 w-3.5" />
            Recent
          </TabsTrigger>
        </TabsList>

        {/* All Reports Tab */}
        <TabsContent value="all" className="space-y-6 mt-4">
          {/* Search — palette for jump-to, plus a persistent filter whose
              query lives in the URL so the library state survives Back. */}
          <ReportSearchPalette onReportSelect={(report) => {
            const matchedItem = allReports.find(r => r.path === report.path);
            if (matchedItem) handleNavigate(matchedItem);
          }} />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setLibraryState({ q: e.target.value }, { replace: true })}
                placeholder="Filter reports by name, purpose or keyword"
                className="pl-9"
                aria-label="Filter reports"
              />
            </div>
            <div className="flex items-center gap-1 overflow-x-auto">
              <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
              {(["all", ...Object.keys(REPORT_DOMAIN_LABELS)] as string[]).map((d) => {
                const label = d === "all" ? "All domains" : REPORT_DOMAIN_LABELS[d as keyof typeof REPORT_DOMAIN_LABELS];
                const isActive = domainFilter === d;
                return (
                  <Button
                    key={d}
                    size="sm"
                    variant={isActive ? "secondary" : "ghost"}
                    className="whitespace-nowrap text-xs"
                    onClick={() => setLibraryState({ domain: d })}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Quick Access — F5: User-driven via favorites, defaults as fallback */}
          {!searchQuery && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Quick Access
              </h2>
              <div className="grid min-w-0 grid-cols-1 gap-3 @md/page:grid-cols-2 @3xl/page:grid-cols-3 @5xl/page:grid-cols-4 @7xl/page:grid-cols-5">
                {(() => {
                  // Favorites first; otherwise the curated default set.
                  const quickReports = favoriteReports.length > 0
                    ? favoriteReports.slice(0, 6)
                    : DEFAULT_QUICK_ACCESS_IDS
                        .map(id => allReports.find(r => r.id === id))
                        .filter(Boolean) as ReportDefinition[];

                  return quickReports.map((r) => (
                    <Card
                      key={r.name}
                      className="cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
                      onClick={() => handleNavigate(r)}
                    >
                      <CardContent className="flex items-center gap-3 p-4">
                        <r.icon className="h-5 w-5 text-primary shrink-0" />
                        <span className="text-sm font-medium">{r.name}</span>
                      </CardContent>
                    </Card>
                  ));
                })()}
              </div>
            </div>
          )}

          {/* Report Categories */}
          <div className="space-y-6">
            {filteredCategories.map((category) => (
              <div key={category.title}>
                <div className="flex items-center gap-2 mb-3">
                  <category.icon className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">{category.title}</h2>
                  <Badge variant="secondary" className="text-xs">
                    {category.reports.length}
                  </Badge>
                </div>
                
                <div className="grid gap-2">
                  {category.reports.map((report) => {
                    const isFav = favorites.some(f => f.report_type === report.reportType);
                    return (
                      <Card
                        key={report.name + report.path}
                        className="cursor-pointer hover:border-primary/30 hover:bg-accent/30 transition-all group"
                        onClick={() => handleNavigate(report)}
                      >
                        <CardContent className="flex items-center justify-between p-4">
                          <div className="flex items-center gap-3">
                            <report.icon className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-medium text-sm">{report.name}</p>
                                {isFav && <Star className="h-3 w-3 text-amber-500 fill-amber-500" />}
                              </div>
                              <p className="text-xs text-muted-foreground">{report.description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => {
                                e.stopPropagation();
                                const existing = favorites.find(f => f.report_type === report.reportType);
                                if (existing) {
                                  toggleFavorite(existing.id);
                                } else {
                                  saveView(report.name, report.reportType, {}, { isFavorite: true });
                                }
                              }}
                            >
                              {isFav ? (
                                <StarOff className="h-3.5 w-3.5 text-amber-500" />
                              ) : (
                                <Star className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {filteredCategories.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">
                  {searchQuery
                    ? `No reports match "${searchQuery}"`
                    : "No reports in this domain"}
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Favorites Tab */}
        <TabsContent value="favorites" className="mt-4">
          {favoriteReports.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Star className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="font-medium mb-1">No favorite reports yet</p>
                <p className="text-sm text-muted-foreground">
                  Click the star icon on any report to add it to your favorites for quick access.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-2">
              {favoriteReports.map((report) => (
                <Card
                  key={report.savedViewId}
                  className="cursor-pointer hover:border-primary/30 hover:bg-accent/30 transition-all group"
                  onClick={() => handleNavigate(report)}
                >
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <report.icon className="h-5 w-5 text-primary shrink-0" />
                      <div>
                        <p className="font-medium text-sm">{report.name}</p>
                        <p className="text-xs text-muted-foreground">{report.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(report.savedViewId);
                        }}
                      >
                        <StarOff className="h-3.5 w-3.5 text-amber-500" />
                      </Button>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Recent Tab */}
        <TabsContent value="recent" className="mt-4">
          {recentReportItems.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <History className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="font-medium mb-1">No recently viewed reports</p>
                <p className="text-sm text-muted-foreground">
                  Reports you view will appear here for quick re-access.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-2">
              {recentReportItems.map((report, idx) => (
                <Card
                  key={`${report.path}-${idx}`}
                  className="cursor-pointer hover:border-primary/30 hover:bg-accent/30 transition-all group"
                  onClick={() => handleNavigate(report)}
                >
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <report.icon className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                      <div>
                        <p className="font-medium text-sm">{report.name}</p>
                        <p className="text-xs text-muted-foreground">{report.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(report.accessedAt).toLocaleDateString()}
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
