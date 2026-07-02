/**
 * FilterBar — the canonical filter row above a DataTable. Holds a search
 * input on the left and chip-style filter controls on the right.
 */
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface FilterBarProps {
  search?: string;
  onSearchChange?: (v: string) => void;
  placeholder?: string;
  children?: ReactNode;
  className?: string;
}

export function FilterBar({
  search,
  onSearchChange,
  placeholder = "Search…",
  children,
  className,
}: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2",
        className,
      )}
    >
      {onSearchChange && (
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            className="h-8 pl-8 text-sm"
          />
        </div>
      )}
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}
