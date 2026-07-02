import { useState, useMemo } from "react";
import { ProjectTask } from "@/hooks/projects/useProjectTasks";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  isSameDay,
  addMonths,
  subMonths,
  getDay,
  isToday,
} from "date-fns";

interface TaskCalendarProps {
  tasks: ProjectTask[];
  onTaskClick?: (task: ProjectTask) => void;
}

export function TaskCalendar({ tasks, onTaskClick }: TaskCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const days = useMemo(() => {
    const start = startOfMonth(currentMonth);
    const end = endOfMonth(currentMonth);
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, ProjectTask[]>();
    tasks.forEach(task => {
      if (task.deadline) {
        const key = task.deadline.split("T")[0];
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(task);
      }
    });
    return map;
  }, [tasks]);

  const startPadding = getDay(startOfMonth(currentMonth));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <CalendarIcon className="h-4 w-4" />
          {format(currentMonth, "MMMM yyyy")}
        </h3>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCurrentMonth(new Date())}>
            Today
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-xs text-muted-foreground text-center mb-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
          <div key={d} className="py-1 font-medium">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-border rounded-md overflow-hidden">
        {Array.from({ length: startPadding }).map((_, i) => (
          <div key={`pad-${i}`} className="bg-card min-h-[80px] p-1" />
        ))}
        {days.map(day => {
          const key = format(day, "yyyy-MM-dd");
          const dayTasks = tasksByDate.get(key) || [];
          return (
            <div
              key={key}
              className={`bg-card min-h-[80px] p-1 ${isToday(day) ? "ring-1 ring-inset ring-primary" : ""}`}
            >
              <span className={`text-xs font-medium ${isToday(day) ? "text-primary" : "text-muted-foreground"}`}>
                {format(day, "d")}
              </span>
              <div className="mt-0.5 space-y-0.5">
                {dayTasks.slice(0, 3).map(t => (
                  <button
                    key={t.id}
                    onClick={() => onTaskClick?.(t)}
                    className="block w-full text-left truncate text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    {t.name}
                  </button>
                ))}
                {dayTasks.length > 3 && (
                  <span className="text-[10px] text-muted-foreground pl-1">+{dayTasks.length - 3} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
