/**
 * Report Command Palette
 * 
 * Fast keyboard-driven report search and navigation.
 * Triggered via a search input on the Report Center or
 * keyboard shortcut.
 */

import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Star } from "lucide-react";
import {
  searchReports,
  REPORT_CATEGORY_LABELS,
  type ReportDefinition,
} from "@/services/reports/ReportRegistry";
import { useReportSavedViews } from "@/hooks/useReportSavedViews";

interface ReportSearchPaletteProps {
  onReportSelect?: (report: ReportDefinition) => void;
}

export function ReportSearchPalette({ onReportSelect }: ReportSearchPaletteProps) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { favorites } = useReportSavedViews();

  const results = useMemo(() => searchReports(query), [query]);

  const favoriteReportIds = new Set(favorites.map(f => f.report_type));

  const handleSelect = (report: ReportDefinition) => {
    onReportSelect?.(report);
    navigate(report.path);
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search reports… (e.g., P&L, aging, trial balance)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="space-y-1 max-h-[400px] overflow-auto">
        {results.map((report) => {
          const Icon = report.icon;
          const isFavorite = favoriteReportIds.has(report.id);

          return (
            <button
              key={report.id}
              onClick={() => handleSelect(report)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent text-left transition-colors group"
            >
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{report.name}</span>
                  {isFavorite && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />}
                </div>
                <p className="text-xs text-muted-foreground truncate">{report.description}</p>
              </div>
              <Badge variant="outline" className="text-xs shrink-0 hidden group-hover:inline-flex">
                {REPORT_CATEGORY_LABELS[report.category]}
              </Badge>
            </button>
          );
        })}

        {results.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No reports matching "{query}"
          </div>
        )}
      </div>
    </div>
  );
}
