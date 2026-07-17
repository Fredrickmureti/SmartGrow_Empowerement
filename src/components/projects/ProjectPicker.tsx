/**
 * ProjectPicker — reusable Combobox to attach a project to any source
 * document (invoice / sales order / purchase order / vendor bill / expense /
 * timesheet line / journal entry line).
 *
 * Writes `project_id` on the parent form. Without this, the analytic
 * ledger triggers on cost/revenue tables stay silent and "profitability"
 * is timesheet-only. This component is the silent-killer fix.
 *
 * Honours company scope (organization + business) via useProjects so the
 * dropdown never leaks projects from other branches.
 */
import { useState, useMemo } from "react";
import { Check, ChevronsUpDown, FolderKanban, X } from "lucide-react";
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
import { useProjects } from "@/hooks/projects";
import { Label } from "@/components/ui/label";
import { useCapability } from "@/hooks/useCapability";

interface ProjectPickerProps {
  value: string | null | undefined;
  onChange: (projectId: string | null) => void;
  /** Optional customer filter — shows only projects for this customer first */
  customerId?: string | null;
  label?: string;
  helperText?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  allowClear?: boolean;
  /** Compact mode for inline use in line rows (no label, smaller button). */
  compact?: boolean;
  /**
   * When false, the picker does not fetch the project list. Pass the
   * parent dialog's `open` state so always-mounted Create/Edit dialogs
   * don't trigger a cross-module fetch on page visit.
   */
  enabled?: boolean;
}

export function ProjectPicker({
  value,
  onChange,
  customerId,
  label = "Project",
  helperText,
  className,
  disabled,
  required,
  allowClear = true,
  compact = false,
  enabled = true,
}: ProjectPickerProps) {
  // Capability gate: when the Projects app is uninstalled for the
  // current org, ProjectPicker MUST NOT render — otherwise consumers
  // (Sales Invoice, Sales Order, Bill, PO, Expense, etc.) ask the user
  // to pick a project that cannot exist. This is the single line that
  // closes the "Project field on Sales Invoice after Projects was
  // uninstalled" bug at the provider level, so every current and
  // future consumer degrades gracefully without knowing which app
  // owns projects. See `src/lib/apps/capabilities.ts`.
  const capability = useCapability("projects.analytic-tagging");
  const { projects, isLoading } = useProjects({ enabled: enabled && capability.available });
  const [open, setOpen] = useState(false);

  if (!capability.ready) return null;
  if (!capability.available) return null;


  const sortedProjects = useMemo(() => {
    const all = (projects || []).filter((p) => p.is_active && !p.is_template);
    if (!customerId) return all;
    // Boost projects that match the customer
    return [...all].sort((a, b) => {
      const am = a.customer_id === customerId ? 0 : 1;
      const bm = b.customer_id === customerId ? 0 : 1;
      return am - bm;
    });
  }, [projects, customerId]);

  const selected = useMemo(
    () => sortedProjects.find((p) => p.id === value) || null,
    [sortedProjects, value]
  );

  if (compact) {
    return (
      <div className={cn("flex gap-1 items-center", className)}>
        <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              className={cn(
                "h-7 text-xs px-2 max-w-[160px] justify-between font-normal",
                !selected && "text-muted-foreground"
              )}
            >
              <span className="flex items-center gap-1 min-w-0">
                <FolderKanban className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {selected ? selected.name : isLoading ? "Loading…" : "Project"}
                </span>
              </span>
              <ChevronsUpDown className="h-3 w-3 ml-1 opacity-50 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[320px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search projects…" />
              <CommandList>
                <CommandEmpty>No projects.</CommandEmpty>
                <CommandGroup>
                  {sortedProjects.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.project_number} ${p.name}`}
                      onSelect={() => { onChange(p.id); setOpen(false); }}
                    >
                      <Check className={cn("mr-2 h-3.5 w-3.5", value === p.id ? "opacity-100" : "opacity-0")} />
                      <span className="w-2 h-2 rounded-full mr-2 shrink-0" style={{ backgroundColor: p.color || "#3b82f6" }} />
                      <span className="text-xs truncate"><span className="text-muted-foreground mr-1">{p.project_number}</span>{p.name}</span>
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
            aria-label="Clear project"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <Label className="text-xs">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
      )}
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              disabled={disabled}
              className="w-full justify-between font-normal"
            >
              {selected ? (
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: selected.color || "#3b82f6" }}
                  />
                  <span className="truncate">
                    <span className="text-muted-foreground mr-1">
                      {selected.project_number}
                    </span>
                    {selected.name}
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <FolderKanban className="h-3.5 w-3.5" />
                  {isLoading ? "Loading projects…" : "Link to a project (optional)"}
                </span>
              )}
              <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[360px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search projects…" />
              <CommandList>
                <CommandEmpty>No projects found.</CommandEmpty>
                <CommandGroup>
                  {sortedProjects.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.project_number} ${p.name}`}
                      onSelect={() => {
                        onChange(p.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-3.5 w-3.5",
                          value === p.id ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span
                        className="w-2 h-2 rounded-full mr-2 shrink-0"
                        style={{ backgroundColor: p.color || "#3b82f6" }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          <span className="text-muted-foreground mr-1">
                            {p.project_number}
                          </span>
                          {p.name}
                        </div>
                        {p.customer && (
                          <div className="text-xs text-muted-foreground truncate">
                            {p.customer.name}
                          </div>
                        )}
                      </div>
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
            className="shrink-0"
            onClick={() => onChange(null)}
            aria-label="Clear project"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {helperText && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
    </div>
  );
}
