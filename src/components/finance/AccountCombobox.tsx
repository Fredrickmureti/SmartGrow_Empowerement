/**
 * AccountCombobox
 * 
 * Searchable account selector using cmdk for the Journal Entry editor.
 * Allows typing to search by account code or name.
 */

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
import type { Account } from "@/hooks/useAccounts";

interface AccountComboboxProps {
  accounts: Account[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Restrict selection to a subset of account types. When omitted all
   * account types are shown. Accountant-grade UIs (e.g. Owner Investment
   * → Equity only) should pass an explicit list to prevent posting to
   * the wrong side of the books.
   */
  allowedTypes?: Array<"asset" | "liability" | "equity" | "income" | "expense">;
}

export function AccountCombobox({
  accounts,
  value,
  onValueChange,
  placeholder = "Select account...",
  disabled = false,
  allowedTypes,
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === value),
    [accounts, value]
  );

  // Group accounts by type for better organization
  const groupedAccounts = useMemo(() => {
    const groups: Record<string, Account[]> = {};
    for (const acc of accounts) {
      if (!acc.is_active) continue;
      const type = acc.account_type;
      if (allowedTypes && !allowedTypes.includes(type as any)) continue;
      if (!groups[type]) groups[type] = [];
      groups[type].push(acc);
    }
    return groups;
  }, [accounts, allowedTypes]);

  const typeLabels: Record<string, string> = {
    asset: "Assets",
    liability: "Liabilities",
    equity: "Equity",
    income: "Income",
    expense: "Expenses",
  };

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
            {selectedAccount
              ? `${selectedAccount.code} - ${selectedAccount.name}`
              : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by code or name..." />
          <CommandList className="max-h-[250px]">
            <CommandEmpty>No account found.</CommandEmpty>
            {Object.entries(groupedAccounts).map(([type, accs]) => (
              <CommandGroup key={type} heading={typeLabels[type] || type}>
                {accs.map((acc) => (
                  <CommandItem
                    key={acc.id}
                    value={`${acc.code} ${acc.name}`}
                    onSelect={() => {
                      onValueChange(acc.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === acc.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="font-mono text-xs mr-2">{acc.code}</span>
                    <span className="truncate">{acc.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
