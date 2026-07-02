import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SavedView, CalendarViewConfig } from "@/hooks/useSavedViews";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isToday,
} from "date-fns";
import { cn } from "@/lib/utils";

interface DynamicCalendarViewProps<T extends Record<string, unknown>> {
  view: SavedView;
  data: T[];
  isLoading?: boolean;
  onItemClick?: (item: T) => void;
  renderEvent?: (item: T) => React.ReactNode;
}

export function DynamicCalendarView<T extends Record<string, unknown>>({
  view,
  data,
  isLoading,
  onItemClick,
  renderEvent,
}: DynamicCalendarViewProps<T>) {
  const config = view.view_config as CalendarViewConfig;
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const days = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart);
    const calEnd = endOfWeek(monthEnd);
    return eachDayOfInterval({ start: calStart, end: calEnd });
  }, [currentMonth]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const item of data) {
      const dateVal = item[config.dateField];
      if (!dateVal) continue;
      const d = new Date(String(dateVal));
      if (isNaN(d.getTime())) continue;
      const key = format(d, "yyyy-MM-dd");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [data, config.dateField]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{view.view_name}</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[140px] text-center">
              {format(currentMonth, "MMMM yyyy")}
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCurrentMonth(new Date())}>
              Today
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pb-2 px-2">
        <div className="grid grid-cols-7">
          {weekDays.map((d) => (
            <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2 border-b">
              {d}
            </div>
          ))}
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const events = eventsByDay.get(key) || [];
            const inMonth = isSameMonth(day, currentMonth);

            return (
              <div
                key={key}
                className={cn(
                  "min-h-[80px] border-b border-r p-1 text-xs",
                  !inMonth && "bg-muted/30 text-muted-foreground",
                  isToday(day) && "bg-primary/5"
                )}
              >
                <div className={cn(
                  "text-right mb-0.5 font-medium",
                  isToday(day) && "text-primary"
                )}>
                  {format(day, "d")}
                </div>
                <div className="space-y-0.5 max-h-[60px] overflow-y-auto">
                  {events.slice(0, 3).map((item, i) => {
                    if (renderEvent) return <div key={i}>{renderEvent(item)}</div>;
                    const title = String(item[config.titleField] || "Untitled");
                    return (
                      <button
                        key={i}
                        className="w-full text-left truncate rounded px-1 py-0.5 bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-[10px] leading-tight"
                        onClick={() => onItemClick?.(item)}
                      >
                        {title}
                      </button>
                    );
                  })}
                  {events.length > 3 && (
                    <Badge variant="secondary" className="text-[9px] h-4 px-1">
                      +{events.length - 3} more
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
