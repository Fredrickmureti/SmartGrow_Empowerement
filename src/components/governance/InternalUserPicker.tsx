/**
 * Searchable picker over internal workspace members of the active org.
 *
 * Replaces raw UUID inputs anywhere a governance form needs to designate
 * a workspace user (actor / subject / co-signer). Portal users (customer
 * and vendor contacts) are excluded by construction because the source
 * table — user_business_access — only lists workspace seats.
 */
import { useState } from "react";
import { Check, ChevronsUpDown, User as UserIcon } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useOrgInternalUsers } from "@/hooks/governance/useOrgInternalUsers";

interface Props {
  organizationId: string;
  value: string | null;
  onChange: (userId: string | null) => void;
  excludeUserIds?: string[];
  placeholder?: string;
  disabled?: boolean;
}

export function InternalUserPicker({
  organizationId,
  value,
  onChange,
  excludeUserIds = [],
  placeholder = "Pick a user",
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data: users = [], isLoading } = useOrgInternalUsers(organizationId);

  const excluded = new Set(excludeUserIds);
  const options = users.filter((u) => !excluded.has(u.user_id));
  const selected = users.find((u) => u.user_id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <Avatar className="h-5 w-5">
                <AvatarImage src={selected.avatar_url ?? undefined} />
                <AvatarFallback>
                  {selected.full_name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{selected.full_name}</span>
              <span className="text-xs text-muted-foreground truncate">
                {selected.email}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <UserIcon className="h-4 w-4" />
              {isLoading ? "Loading users…" : placeholder}
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[--radix-popover-trigger-width] min-w-[320px]" align="start">
        <Command>
          <CommandInput placeholder="Search by name or email…" />
          <CommandList>
            <CommandEmpty>No workspace users found.</CommandEmpty>
            <CommandGroup>
              {options.map((u) => (
                <CommandItem
                  key={u.user_id}
                  value={`${u.full_name} ${u.email}`}
                  onSelect={() => {
                    onChange(u.user_id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={u.avatar_url ?? undefined} />
                    <AvatarFallback>
                      {u.full_name.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{u.full_name}</div>
                    <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {u.primary_role}
                  </Badge>
                  <Check
                    className={cn(
                      "h-4 w-4",
                      value === u.user_id ? "opacity-100" : "opacity-0",
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
