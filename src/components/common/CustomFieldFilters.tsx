import { useState, useMemo } from "react";
import { useEntityFields, EntityType, EntityFieldConfig } from "@/hooks/useEntityFields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Filter } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface CustomFieldFilter {
  fieldKey: string;
  value: string;
}

interface CustomFieldFiltersProps {
  entityType: EntityType;
  filters: CustomFieldFilter[];
  onFiltersChange: (filters: CustomFieldFilter[]) => void;
}

/**
 * Renders filter controls for custom fields marked as `is_filterable` in Studio.
 * Supports select/multiselect (dropdown), text (input), boolean (yes/no), and number (input).
 */
export function CustomFieldFilters({
  entityType,
  filters,
  onFiltersChange,
}: CustomFieldFiltersProps) {
  const { filterableFields, isLoading } = useEntityFields(entityType);
  const [isOpen, setIsOpen] = useState(false);

  const activeFilterCount = filters.length;

  const handleAddFilter = (fieldKey: string, value: string) => {
    const existing = filters.findIndex(f => f.fieldKey === fieldKey);
    if (existing >= 0) {
      const updated = [...filters];
      updated[existing] = { fieldKey, value };
      onFiltersChange(updated);
    } else {
      onFiltersChange([...filters, { fieldKey, value }]);
    }
  };

  const handleRemoveFilter = (fieldKey: string) => {
    onFiltersChange(filters.filter(f => f.fieldKey !== fieldKey));
  };

  const handleClearAll = () => {
    onFiltersChange([]);
  };

  if (isLoading || filterableFields.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Custom Filters
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-3">
            <div className="text-sm font-medium">Filter by Custom Fields</div>
            {filterableFields.map((field) => (
              <FilterControl
                key={field.id}
                field={field}
                value={filters.find(f => f.fieldKey === field.field_key)?.value || ""}
                onChange={(value) => {
                  if (value) {
                    handleAddFilter(field.field_key, value);
                  } else {
                    handleRemoveFilter(field.field_key);
                  }
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Active filter badges */}
      {filters.map((filter) => {
        const field = filterableFields.find(f => f.field_key === filter.fieldKey);
        if (!field) return null;
        return (
          <Badge key={filter.fieldKey} variant="secondary" className="gap-1 pl-2">
            <span className="text-xs text-muted-foreground">{field.field_label}:</span>
            <span className="text-xs font-medium">{getDisplayValue(field, filter.value)}</span>
            <button
              onClick={() => handleRemoveFilter(filter.fieldKey)}
              className="ml-1 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        );
      })}

      {activeFilterCount > 1 && (
        <Button variant="ghost" size="sm" onClick={handleClearAll} className="text-xs h-6 px-2">
          Clear all
        </Button>
      )}
    </div>
  );
}

function getDisplayValue(field: EntityFieldConfig, value: string): string {
  if (field.field_type === "select" || field.field_type === "multiselect") {
    const option = field.options?.find(o => o.value === value);
    return option?.label || value;
  }
  if (field.field_type === "boolean") {
    return value === "true" ? "Yes" : "No";
  }
  return value;
}

function FilterControl({
  field,
  value,
  onChange,
}: {
  field: EntityFieldConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.field_type === "select" || field.field_type === "multiselect") {
    return (
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{field.field_label}</label>
        <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={`All ${field.field_label}`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {field.options?.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.field_type === "boolean") {
    return (
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{field.field_label}</label>
        <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Text, number, date fields — simple text input filter
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{field.field_label}</label>
      <Input
        className="h-8 text-xs"
        placeholder={`Filter by ${field.field_label.toLowerCase()}...`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
