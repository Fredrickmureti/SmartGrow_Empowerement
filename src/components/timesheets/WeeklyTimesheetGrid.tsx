import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { format, isSameDay } from "date-fns";
import { Timesheet } from "@/hooks/timesheets/useTimesheets";
import { Badge } from "@/components/ui/badge";

interface WeeklyTimesheetGridProps {
  weekDays: Date[];
  timesheets: Timesheet[];
  onAddEntry: (date: Date) => void;
}

export function WeeklyTimesheetGrid({ weekDays, timesheets, onAddEntry }: WeeklyTimesheetGridProps) {
  const getEntriesForDay = (day: Date) => {
    return timesheets.filter(t => isSameDay(new Date(t.date), day));
  };

  const getDayTotal = (day: Date) => {
    return getEntriesForDay(day).reduce((sum, t) => sum + (t.hours || 0), 0);
  };

  const isToday = (day: Date) => isSameDay(day, new Date());
  const isWeekend = (day: Date) => day.getDay() === 0 || day.getDay() === 6;

  return (
    <Card>
      <CardContent className="p-2 sm:p-0">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-0 sm:divide-x">
          {weekDays.map((day) => {
            const entries = getEntriesForDay(day);
            const dayTotal = getDayTotal(day);
            
            return (
              <div 
                key={day.toISOString()} 
                className={`min-h-[160px] sm:min-h-[200px] rounded-lg sm:rounded-none border sm:border-0 ${isWeekend(day) ? 'bg-muted/30' : ''} ${isToday(day) ? 'bg-primary/5' : ''}`}
              >
                {/* Day Header */}
                <div className={`p-2 sm:p-3 border-b text-center ${isToday(day) ? 'bg-primary/10' : ''}`}>
                  <div className="text-xs text-muted-foreground uppercase">
                    {format(day, "EEE")}
                  </div>
                  <div className={`text-base sm:text-lg font-semibold ${isToday(day) ? 'text-primary' : ''}`}>
                    {format(day, "d")}
                  </div>
                  {dayTotal > 0 && (
                    <div className="text-xs font-medium text-muted-foreground mt-1">
                      {dayTotal}h
                    </div>
                  )}
                </div>
                
                {/* Day Content */}
                <div className="p-2 space-y-2">
                  {entries.map((entry) => (
                    <div 
                      key={entry.id}
                      className="p-2 rounded-md bg-card border text-xs space-y-1 cursor-pointer hover:border-primary/50 transition-colors"
                    >
                      <div className="font-medium truncate">
                        {entry.project?.name || "No Project"}
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-muted-foreground truncate flex-1 min-w-0">
                          {entry.description?.slice(0, 20) || "No description"}
                        </span>
                        <Badge variant="secondary" className="text-xs flex-shrink-0">
                          {entry.hours}h
                        </Badge>
                      </div>
                      {entry.is_billable && (
                        <Badge variant="outline" className="text-xs bg-green-500/10 text-green-600">
                          Billable
                        </Badge>
                      )}
                    </div>
                  ))}
                  
                  {/* Add Entry Button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-8 border border-dashed text-muted-foreground hover:text-foreground"
                    onClick={() => onAddEntry(day)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
