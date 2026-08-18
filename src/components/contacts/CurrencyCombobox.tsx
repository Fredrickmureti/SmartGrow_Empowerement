import { useState, useMemo } from "react";
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
import type { Currency } from "@/hooks/useCurrencies";

interface CurrencyComboboxProps {
  currencies: Currency[];
  value: string;
  onValueChange: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shown when the search matches nothing in the supplied list. */
  emptyMessage?: React.ReactNode;
  /** Persistent hint rendered under the list (e.g. how to enable more codes). */
  footer?: React.ReactNode;
}

export function CurrencyCombobox({
  currencies,
  value,
  onValueChange,
  placeholder = "Select currency...",
  disabled = false,
  emptyMessage = "No currency found.",
  footer,
}: CurrencyComboboxProps) {
  const [open, setOpen] = useState(false);


  const selected = useMemo(
    () => currencies.find((c) => c.code === value),
    [currencies, value]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal h-9 text-left",
            !value && "text-muted-foreground"
          )}
          disabled={disabled}
        >
          <span className="truncate">
            {selected ? `${selected.code} — ${selected.name}` : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search currency..." />
          <CommandList className="max-h-[250px]">
            <CommandEmpty>
              <span className="block px-3 py-2 text-xs text-muted-foreground text-left">
                {emptyMessage}
              </span>
            </CommandEmpty>

            <CommandGroup>
              {currencies.map((c) => (
                <CommandItem
                  key={c.code}
                  value={`${c.code} ${c.name}`}
                  onSelect={() => {
                    onValueChange(c.code);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === c.code ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">
                    {c.code} — {c.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
