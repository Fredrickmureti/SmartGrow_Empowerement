import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SavedView, GanttViewConfig } from "@/hooks/useSavedViews";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  format,
  differenceInDays,
  addDays,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  isWithinInterval,
  max as dateMax,
  min as dateMin,
} from "date-fns";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DynamicGanttViewProps<T extends Record<string, unknown>> {
  view: SavedView;
  data: T[];
  isLoading?: boolean;
  onBarClick?: (item: T) => void;
}

const DAYS_VISIBLE = 28; // 4 weeks

export function DynamicGanttView<T extends Record<string, unknown>>({
  view,
  data,
  isLoading,
  onBarClick,
}: DynamicGanttViewProps<T>) {
  const config = view.view_config as GanttViewConfig;
  const [viewStart, setViewStart] = useState(() => startOfWeek(new Date()));

  const viewEnd = useMemo(() => addDays(viewStart, DAYS_VISIBLE - 1), [viewStart]);

  const dayColumns = useMemo(() => {
    const cols: Date[] = [];
    for (let i = 0; i < DAYS_VISIBLE; i++) {
      cols.push(addDays(viewStart, i));
    }
    return cols;
  }, [viewStart]);

  const rows = useMemo(() => {
    return data
      .map((item) => {
        const startVal = item[config.startField];
        const endVal = item[config.endField];
        const name = String(item[config.nameField] || "Untitled");
        const progress = config.progressField
          ? Number(item[config.progressField] || 0)
          : undefined;

        if (!startVal || !endVal) return null;

        const start = new Date(String(startVal));
        const end = new Date(String(endVal));
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

        return { item, name, start, end, progress };
      })
      .filter(Boolean) as Array<{
      item: T;
      name: string;
      start: Date;
      end: Date;
      progress?: number;
    }>;
  }, [data, config]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const colWidth = 100 / DAYS_VISIBLE;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{view.view_name}</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewStart(subWeeks(viewStart, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[180px] text-center">
              {format(viewStart, "MMM d")} – {format(viewEnd, "MMM d, yyyy")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewStart(addWeeks(viewStart, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setViewStart(startOfWeek(new Date()))}
            >
              Today
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <div className="min-w-[800px]">
          {/* Header row with day labels */}
          <div className="flex border-b">
            <div className="w-[200px] shrink-0 px-3 py-2 text-xs font-medium text-muted-foreground border-r bg-muted/30">
              Task
            </div>
            <div className="flex-1 flex">
              {dayColumns.map((day, i) => (
                <div
                  key={i}
                  className={cn(
                    "text-center text-[10px] font-medium py-2 border-r text-muted-foreground",
                    [0, 6].includes(day.getDay()) && "bg-muted/20"
                  )}
                  style={{ width: `${colWidth}%` }}
                >
                  <div>{format(day, "EEE")}</div>
                  <div>{format(day, "d")}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Task rows */}
          {rows.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No items with valid start/end dates
            </div>
          ) : (
            rows.map((row, idx) => {
              const clampedStart = dateMax([row.start, viewStart]);
              const clampedEnd = dateMin([row.end, viewEnd]);
              const isVisible = clampedStart <= clampedEnd;

              const offsetDays = differenceInDays(clampedStart, viewStart);
              const duration = differenceInDays(clampedEnd, clampedStart) + 1;
              const leftPct = (offsetDays / DAYS_VISIBLE) * 100;
              const widthPct = (duration / DAYS_VISIBLE) * 100;

              return (
                <div key={idx} className="flex border-b hover:bg-muted/10 group">
                  <div className="w-[200px] shrink-0 px-3 py-2 text-xs truncate border-r flex items-center">
                    {row.name}
                  </div>
                  <div className="flex-1 relative h-10">
                    {isVisible && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            className="absolute top-1.5 h-6 rounded bg-primary/80 hover:bg-primary transition-colors cursor-pointer overflow-hidden"
                            style={{
                              left: `${leftPct}%`,
                              width: `${Math.max(widthPct, 1)}%`,
                            }}
                            onClick={() => onBarClick?.(row.item)}
                          >
                            {row.progress !== undefined && (
                              <div
                                className="absolute inset-y-0 left-0 bg-primary rounded-l"
                                style={{ width: `${Math.min(row.progress, 100)}%` }}
                              />
                            )}
                            <span className="relative z-10 text-[10px] text-primary-foreground px-1 truncate block leading-6">
                              {row.name}
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-xs space-y-0.5">
                            <div className="font-medium">{row.name}</div>
                            <div>
                              {format(row.start, "MMM d")} – {format(row.end, "MMM d, yyyy")}
                            </div>
                            {row.progress !== undefined && (
                              <div>{Math.round(row.progress)}% complete</div>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
