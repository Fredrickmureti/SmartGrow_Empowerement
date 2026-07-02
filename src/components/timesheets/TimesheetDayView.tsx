/**
 * TimesheetDayView — focused day list for MyTimesheets.
 * Inline edit (hours, billable, description), quick delete, and a
 * mini day-picker strip across the current week.
 */
import { useState, useEffect } from "react";
import { format, isSameDay } from "date-fns";
import { Trash2, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { Timesheet } from "@/hooks/timesheets/useTimesheets";

interface Props {
  weekDays: Date[];
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  entries: Timesheet[];
  projects: { id: string; name: string }[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Timesheet>) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

export function TimesheetDayView({
  weekDays, selectedDate, onSelectDate, entries, onAdd, onUpdate, onDelete,
}: Props) {
  const dayTotal = entries.reduce((s, e) => s + (e.hours || 0), 0);

  return (
    <div className="space-y-4">
      {/* Day strip */}
      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((d) => {
          const active = isSameDay(d, selectedDate);
          return (
            <button
              key={d.toISOString()}
              onClick={() => onSelectDate(d)}
              className={`rounded-md border p-2 text-center transition-colors ${
                active ? "border-primary bg-primary/10" : "hover:bg-muted/50"
              }`}
            >
              <div className="text-[10px] uppercase text-muted-foreground">{format(d, "EEE")}</div>
              <div className={`text-lg font-semibold ${active ? "text-primary" : ""}`}>{format(d, "d")}</div>
            </button>
          );
        })}
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">{format(selectedDate, "EEEE, MMM d, yyyy")}</h3>
              <p className="text-xs text-muted-foreground">{entries.length} entries · {dayTotal}h total</p>
            </div>
            <Button size="sm" onClick={onAdd}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No entries for this day.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <DayEntryRow key={e.id} entry={e} onUpdate={onUpdate} onDelete={onDelete} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DayEntryRow({
  entry, onUpdate, onDelete,
}: { entry: Timesheet; onUpdate: Props["onUpdate"]; onDelete: Props["onDelete"] }) {
  const [hours, setHours] = useState(String(entry.hours));
  const [desc, setDesc] = useState(entry.description || "");
  const [billable, setBillable] = useState(entry.is_billable);
  const readOnly = entry.status !== "draft" && entry.status !== "rejected";

  useEffect(() => { setHours(String(entry.hours)); setDesc(entry.description || ""); setBillable(entry.is_billable); }, [entry.id]);

  const commit = (patch: Partial<Timesheet>) => onUpdate(entry.id, patch);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <div className="flex-1 min-w-[180px]">
        <div className="text-sm font-medium truncate">{entry.project?.name || "No project"}</div>
        <Input
          value={desc}
          disabled={readOnly}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc !== (entry.description || "") && commit({ description: desc || null })}
          placeholder="Description"
          className="h-7 mt-1 text-xs"
        />
      </div>
      <Input
        type="number"
        step="0.25" min="0" max="24"
        value={hours}
        disabled={readOnly}
        onChange={(e) => setHours(e.target.value)}
        onBlur={() => Number(hours) !== entry.hours && commit({ hours: Number(hours) })}
        className="h-8 w-20 text-right"
      />
      <div className="flex items-center gap-2">
        <Switch
          checked={billable}
          disabled={readOnly}
          onCheckedChange={(v) => { setBillable(v); commit({ is_billable: v }); }}
        />
        <span className="text-xs text-muted-foreground">Billable</span>
      </div>
      <Badge variant="outline" className="capitalize text-xs">{entry.status}</Badge>
      <Button
        variant="ghost" size="icon"
        disabled={readOnly}
        onClick={() => onDelete(entry.id)}
        aria-label="Delete entry"
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    </li>
  );
}