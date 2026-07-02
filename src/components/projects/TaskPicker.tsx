/**
 * TaskPicker — compact combobox to attach a project_task to a line item.
 *
 * Always scoped to a project via `projectId`. Without a projectId, it shows
 * a disabled hint button. Used in invoice/SO/PO/bill line rows alongside
 * <ProjectPicker compact />.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, ListTodo, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";

interface TaskRow {
  id: string;
  name: string;
  stage_id: string | null;
  is_active: boolean;
}

interface TaskPickerProps {
  projectId: string | null | undefined;
  value: string | null | undefined;
  onChange: (taskId: string | null) => void;
  compact?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
}

export function TaskPicker({
  projectId,
  value,
  onChange,
  compact = true,
  disabled,
  allowClear = true,
}: TaskPickerProps) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setTasks([]);
      return;
    }
    let alive = true;
    setLoading(true);
    void supabase
      .from("project_tasks")
      .select("id, name, stage_id, is_active")
      .eq("project_id", projectId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(500)
      .then(({ data }) => {
        if (!alive) return;
        setTasks((data ?? []) as TaskRow[]);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [projectId]);

  const selected = useMemo(
    () => tasks.find((t) => t.id === value) || null,
    [tasks, value]
  );

  const buttonLabel = !projectId
    ? "Pick project first"
    : selected
      ? selected.name
      : loading ? "Loading…" : "Task";

  return (
    <div className="flex gap-1 items-center">
      <Popover open={open} onOpenChange={(o) => projectId && !disabled && setOpen(o)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            disabled={disabled || !projectId}
            className={cn(
              "justify-between font-normal",
              compact ? "h-7 text-xs px-2 max-w-[160px]" : "w-full",
              !selected && "text-muted-foreground"
            )}
          >
            <span className="flex items-center gap-1 min-w-0">
              <ListTodo className="h-3 w-3 shrink-0" />
              <span className="truncate">{buttonLabel}</span>
            </span>
            {loading
              ? <Loader2 className="h-3 w-3 ml-1 animate-spin shrink-0" />
              : <ChevronsUpDown className="h-3 w-3 ml-1 opacity-50 shrink-0" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search tasks…" />
            <CommandList>
              <CommandEmpty>No tasks.</CommandEmpty>
              <CommandGroup>
                {tasks.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={t.name}
                    onSelect={() => { onChange(t.id); setOpen(false); }}
                  >
                    <Check className={cn("mr-2 h-3.5 w-3.5", value === t.id ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{t.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowClear && selected && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => onChange(null)}
          aria-label="Clear task"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
