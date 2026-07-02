import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "cmdk";
import { Check, ChevronsUpDown, X, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityFieldConfig } from "@/hooks/useEntityFields";
import { useOrganization } from "@/hooks/useOrganization";

interface EntityLookupWidgetProps {
  field: EntityFieldConfig;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

// Map entity model names to their Supabase table and display field
const MODEL_TABLE_MAP: Record<string, { table: string; displayField: string; searchFields: string[] }> = {
  contact: { table: "contacts", displayField: "display_name", searchFields: ["display_name", "email"] },
  contacts: { table: "contacts", displayField: "display_name", searchFields: ["display_name", "email"] },
  product: { table: "products", displayField: "name", searchFields: ["name", "sku"] },
  products: { table: "products", displayField: "name", searchFields: ["name", "sku"] },
  invoice: { table: "invoices", displayField: "invoice_number", searchFields: ["invoice_number"] },
  invoices: { table: "invoices", displayField: "invoice_number", searchFields: ["invoice_number"] },
  estimate: { table: "estimates", displayField: "estimate_number", searchFields: ["estimate_number"] },
  estimates: { table: "estimates", displayField: "estimate_number", searchFields: ["estimate_number"] },
  project: { table: "projects", displayField: "name", searchFields: ["name"] },
  projects: { table: "projects", displayField: "name", searchFields: ["name"] },
  employee: { table: "employees", displayField: "first_name", searchFields: ["first_name", "last_name"] },
  employees: { table: "employees", displayField: "first_name", searchFields: ["first_name", "last_name"] },
  account: { table: "accounts", displayField: "name", searchFields: ["name", "code"] },
  accounts: { table: "accounts", displayField: "name", searchFields: ["name", "code"] },
};

interface LookupOption {
  id: string;
  label: string;
}

export function EntityLookupWidget({ field, value, onChange, disabled }: EntityLookupWidgetProps) {
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<LookupOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [displayValue, setDisplayValue] = useState<string>("");

  const modelKey = (field.related_model || "").toLowerCase();
  const modelConfig = MODEL_TABLE_MAP[modelKey];
  const displayField = field.related_display_field || modelConfig?.displayField || "name";

  // Resolve display value for the current selected ID
  useEffect(() => {
    if (!value || !modelConfig || !currentOrg) {
      setDisplayValue("");
      return;
    }

    const resolve = async () => {
      try {
        const { data } = await supabase
          .from(modelConfig.table as any)
          .select(`id, ${displayField}`)
          .eq("id", value)
          .eq("organization_id", currentOrg.id)
          .single();

        if (data) {
          setDisplayValue((data as any)[displayField] || value);
        }
      } catch {
        setDisplayValue(value);
      }
    };
    resolve();
  }, [value, modelConfig, displayField, currentOrg]);

  // Search for options
  const handleSearch = useCallback(async (searchTerm: string) => {
    if (!modelConfig || !currentOrg) return;

    setLoading(true);
    try {
      let query = supabase
        .from(modelConfig.table as any)
        .select(`id, ${displayField}`)
        .eq("organization_id", currentOrg.id)
        .limit(20);

      if (searchTerm) {
        // Use ilike on the display field for search
        query = query.ilike(displayField, `%${searchTerm}%`);
      }

      const { data, error } = await query;

      if (error) throw error;

      setOptions(
        (data || []).map((item: any) => ({
          id: item.id,
          label: item[displayField] || item.id,
        }))
      );
    } catch (error) {
      console.error("Lookup search error:", error);
      setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [modelConfig, displayField, currentOrg]);

  // Load initial options when opening
  useEffect(() => {
    if (open) {
      handleSearch(search);
    }
  }, [open, search, handleSearch]);

  if (!modelConfig) {
    return (
      <div className="text-sm text-muted-foreground italic p-2 border rounded-md bg-muted/30">
        Related model "{field.related_model}" is not configured for lookup.
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal",
            !value && "text-muted-foreground"
          )}
          disabled={disabled}
        >
          <span className="truncate">
            {value ? displayValue || "Loading..." : field.placeholder || `Select ${field.related_model}...`}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            {value && !disabled && (
              <X
                className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                  setDisplayValue("");
                }}
              />
            )}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="flex items-center border-b px-3">
          <Search className="h-4 w-4 shrink-0 opacity-50" />
          <input
            className="flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground pl-2"
            placeholder={`Search ${field.related_model}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="max-h-60 overflow-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : options.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          ) : (
            options.map((option) => (
              <button
                key={option.id}
                className={cn(
                  "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                  value === option.id && "bg-accent"
                )}
                onClick={() => {
                  onChange(option.id);
                  setDisplayValue(option.label);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === option.id ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="truncate">{option.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
