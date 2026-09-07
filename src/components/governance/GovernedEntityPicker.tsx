/**
 * Searchable picker over the live records of a governed entity type.
 *
 * The Self-Action Override dialog uses this in place of the old "type
 * an entity_id UUID" input — co-signers pick a real row (a loan, a
 * repayment, an expense, …) and the dialog auto-derives the subject
 * user from that row when the catalogue marks the action as
 * `subjectMode: "from_entity"`.
 */
import { useState } from "react";
import { Check, ChevronsUpDown, FileText, Loader2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useGovernedEntityOptions,
  type GovernedEntityOption,
} from "@/hooks/governance/useGovernedEntityOptions";
import {
  ENTITY_TYPE_LABELS,
  type SelfActionEntityType,
} from "@/lib/governance/selfActionCatalogue";

interface Props {
  organizationId: string;
  entityType: SelfActionEntityType | null;
  value: string | null;
  onChange: (option: GovernedEntityOption | null) => void;
  disabled?: boolean;
}

export function GovernedEntityPicker({
  organizationId,
  entityType,
  value,
  onChange,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data: options = [], isLoading } = useGovernedEntityOptions(
    organizationId,
    entityType,
  );
  const selected = options.find((o) => o.id === value) ?? null;
  const label = entityType ? ENTITY_TYPE_LABELS[entityType] : "entity";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || !entityType}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{selected.label}</span>
              {selected.hint && (
                <span className="text-xs text-muted-foreground truncate">
                  {selected.hint}
                </span>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {entityType
                ? isLoading
                  ? `Loading ${label}s…`
                  : `Pick a ${label} pending approval`
                : "Pick an action first"}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[360px]"
        align="start"
      >
        <Command>
          <CommandInput placeholder={`Search ${label}s…`} />
          <CommandList>
            <CommandEmpty>
              No pending {label}s found in this organization.
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={`${o.label} ${o.hint ?? ""}`}
                  onSelect={() => {
                    onChange(o);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{o.label}</div>
                    {o.hint && (
                      <div className="text-xs text-muted-foreground truncate">
                        {o.hint}
                      </div>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value === o.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
