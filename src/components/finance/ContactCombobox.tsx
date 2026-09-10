/**
 * ContactCombobox
 *
 * Searchable client (counterparty) selector for the Journal Entry editor.
 * Required on any GL line that posts to an AR or AP control account so the
 * customer / vendor subledger always agrees with the GL (see ADR-0031).
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Counterparty } from "@/hooks/useCounterparties";

type ContactRole = "customer" | "supplier" | "both" | "any";

interface ContactComboboxProps {
  contacts: Counterparty[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
  role?: ContactRole;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}

export function ContactCombobox({
  contacts,
  value,
  onValueChange,
  role = "any",
  placeholder = "Select client...",
  invalid,
  disabled,
}: ContactComboboxProps) {
  const [open, setOpen] = useState(false);

  // Every counterparty in this institution is a client; the `role` prop is
  // retained so control-account lines keep declaring their intent, but there
  // is no separate supplier register to filter against.
  const filtered = useMemo(
    () => contacts.filter((c) => c.is_active),
    [contacts],
  );

  const selected = useMemo(
    () => contacts.find((c) => c.id === value),
    [contacts, value],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal h-9 text-left",
            !value && "text-muted-foreground",
            invalid && "border-destructive text-destructive",
          )}
        >
          <span className="truncate">{selected?.name ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search clients..." />
          <CommandList className="max-h-[250px]">
            <CommandEmpty>No client found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.name} ${c.reference ?? ""} ${c.email ?? ""}`}
                  onSelect={() => {
                    onValueChange(c.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === c.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{c.name}</span>
                  {c.reference && (
                    <span className="ml-2 text-xs text-muted-foreground truncate">
                      {c.reference}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
