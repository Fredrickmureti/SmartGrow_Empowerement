/**
 * SaveViewButton — Allows saving & loading filter presets on report pages.
 * 
 * F4: Integrates useReportSavedViews into individual report pages.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bookmark, ChevronDown, Plus, Trash2, Check } from "lucide-react";
import { useReportSavedViews, type ReportSavedView } from "@/hooks/useReportSavedViews";

interface SaveViewButtonProps {
  /** Report type identifier, e.g. "trial-balance" */
  reportType: string;
  /** Current filter state to persist */
  currentFilters: Record<string, any>;
  /** Called when user loads a saved view */
  onLoadView: (filters: Record<string, any>) => void;
}

export function SaveViewButton({
  reportType,
  currentFilters,
  onLoadView,
}: SaveViewButtonProps) {
  const { views, saveView, deleteView } = useReportSavedViews(reportType);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    if (!viewName.trim()) return;
    setIsSaving(true);
    try {
      await saveView(viewName.trim(), reportType, currentFilters);
      setViewName("");
      setSaveOpen(false);
    } catch {
      // toast handled by hook
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* Load saved view */}
      {views.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Bookmark className="h-3.5 w-3.5" />
              Views
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {views.map((view) => (
              <DropdownMenuItem
                key={view.id}
                className="flex items-center justify-between"
                onClick={() => onLoadView(view.filters_json)}
              >
                <span className="truncate">{view.view_name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 ml-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteView(view.id);
                  }}
                >
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSaveOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-2" />
              Save current view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Save new view */}
      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          {views.length === 0 ? (
            <Button variant="outline" size="sm" className="gap-1.5">
              <Bookmark className="h-3.5 w-3.5" />
              Save View
            </Button>
          ) : (
            <span />
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-3">
          <div className="space-y-2">
            <p className="text-sm font-medium">Save Current Filters</p>
            <Input
              placeholder="View name…"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              autoFocus
            />
            <Button
              size="sm"
              className="w-full gap-1.5"
              disabled={!viewName.trim() || isSaving}
              onClick={handleSave}
            >
              <Check className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
