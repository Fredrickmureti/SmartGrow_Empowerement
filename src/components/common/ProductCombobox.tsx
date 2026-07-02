/**
 * ProductCombobox — searchable product picker used by line-item editors
 * across Invoices, Recurring Invoices, Estimates, Proforma, Sales Orders,
 * Purchase Orders and Bills.
 *
 * Replaces a plain `<Select>` listing thousands of products (unusable for
 * any business with a real catalog). Backed by shadcn `Command` + `Popover`,
 * filters client-side by name and SKU and caps the rendered list so 5k+
 * products stay responsive.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
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

export interface ProductOption {
  id: string;
  name: string;
  sku?: string | null;
  unit_price?: number;
  is_active?: boolean | null;
}

interface ProductComboboxProps<T extends ProductOption> {
  products: T[];
  value: string | null | undefined;
  onChange: (productId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Render extra content on the right side of each list row (e.g. stock badge). */
  renderItemRight?: (product: T) => ReactNode;
  /** Optional price formatter — when omitted the price is not shown. */
  formatCurrency?: (n: number) => string;
  /** Cap the rendered list. Default 100 — enough for paging, keeps DOM light. */
  maxVisible?: number;
}

export function ProductCombobox<T extends ProductOption>({
  products,
  value,
  onChange,
  placeholder = "Select product",
  disabled,
  className,
  renderItemRight,
  formatCurrency,
  maxVisible = 100,
}: ProductComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Active-only, then optional text filter, then cap.
  const filtered = useMemo(() => {
    const active = products.filter((p) => p.is_active !== false);
    const q = query.trim().toLowerCase();
    const matched = q
      ? active.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.sku ?? "").toLowerCase().includes(q),
        )
      : active;
    return matched.slice(0, maxVisible);
  }, [products, query, maxVisible]);

  const selected = useMemo(
    () => (value ? products.find((p) => p.id === value) : undefined),
    [products, value],
  );

  const totalActive = products.filter((p) => p.is_active !== false).length;
  const truncated =
    query.trim().length > 0
      ? false
      : totalActive > filtered.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-8 w-full justify-between px-2 font-normal",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {selected ? selected.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(420px,calc(100vw-2rem))] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-2">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search by name or SKU…"
              className="h-9 border-0 px-0 focus:ring-0"
            />
          </div>
          <CommandList className="max-h-72">
            <CommandEmpty>No products found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange(p.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      value === p.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {p.name}
                      {formatCurrency && typeof p.unit_price === "number" && (
                        <span className="text-muted-foreground">
                          {" — "}
                          {formatCurrency(p.unit_price)}
                        </span>
                      )}
                    </div>
                    {p.sku && (
                      <div className="truncate text-xs text-muted-foreground">
                        SKU {p.sku}
                      </div>
                    )}
                  </div>
                  {renderItemRight && (
                    <div className="shrink-0">{renderItemRight(p)}</div>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            {truncated && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                Showing first {filtered.length} of {totalActive}. Type to
                narrow.
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default ProductCombobox;
