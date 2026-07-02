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
import type { Country } from "@/hooks/useCountries";

interface CountryComboboxProps {
  countries: Country[];
  value: string;
  onValueChange: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function CountryCombobox({
  countries,
  value,
  onValueChange,
  placeholder = "Select country...",
  disabled = false,
}: CountryComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedCountry = useMemo(
    () => countries.find((c) => c.code === value),
    [countries, value]
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
            {selectedCountry ? selectedCountry.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country..." />
          <CommandList className="max-h-[250px]">
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {countries.map((c) => (
                <CommandItem
                  key={c.code}
                  value={c.name}
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
                  <span className="truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
