/**
 * AlternateProductPicker — supplier-facing substitute product selector.
 *
 * The portal user has no read access to `products` (RLS is buyer-scoped), so
 * the catalogue is resolved through the canonical, invitation-scoped RPC
 * `rfq_portal_search_products`. There is no RFQ-local product logic here:
 * the server decides which catalogue rows the invited supplier may see, and
 * `_rfq_quotation_item_validate_alternate` re-checks the chosen product on
 * write. This control only captures the intent.
 */
import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
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
import { cn } from "@/lib/utils";

export interface PortalProductOption {
  id: string;
  name: string;
  sku: string | null;
}

interface Props {
  invitationId: string;
  value: PortalProductOption | null;
  disabled?: boolean;
  onChange: (product: PortalProductOption | null) => void;
}

export function AlternateProductPicker({ invitationId, value, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PortalProductOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      const { data, error } = await (supabase as any).rpc("rfq_portal_search_products", {
        _invitation_id: invitationId,
        _query: query || null,
        _limit: 20,
      });
      if (cancelled) return;
      setOptions(error ? [] : ((data ?? []) as PortalProductOption[]));
      setLoading(false);
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, invitationId]);

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            size="sm"
            disabled={disabled}
            className={cn(
              "w-full justify-between font-normal",
              !value && "text-muted-foreground",
            )}
          >
            <span className="truncate">
              {value ? value.sku ? `${value.sku} — ${value.name}` : value.name : "Same as requested"}
            </span>
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search buyer catalogue…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>{loading ? "Searching…" : "No matching product."}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value?.id === option.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">
                      {option.sku ? `${option.sku} — ${option.name}` : option.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && !disabled && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Clear alternate product"
          onClick={() => onChange(null)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export default AlternateProductPicker;
