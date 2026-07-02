import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { format, parseISO } from "date-fns";
import { CalendarIcon, X, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityFieldConfig, FieldOption } from "@/hooks/useEntityFields";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState } from "react";
import { FileUploadWidget } from "./widgets/FileUploadWidget";
import { EntityLookupWidget } from "./widgets/EntityLookupWidget";
import { RichTextWidget } from "./widgets/RichTextWidget";
import { ComputedFieldWidget } from "./widgets/ComputedFieldWidget";

interface CustomFieldRendererProps {
  field: EntityFieldConfig;
  value: string | null;
  valueJson?: Record<string, any> | null;
  onChange: (value: string | null, valueJson?: Record<string, any> | null) => void;
  disabled?: boolean;
  className?: string;
}

export function CustomFieldRenderer({
  field,
  value,
  valueJson,
  onChange,
  disabled = false,
  className,
}: CustomFieldRendererProps) {
  const [dateOpen, setDateOpen] = useState(false);

  const renderField = () => {
    switch (field.field_type) {
      case "text":
        return (
          <Input
            id={field.field_key}
            value={value || ""}
            onChange={(e) => onChange(e.target.value || null)}
            placeholder={field.placeholder || undefined}
            disabled={disabled}
            required={field.is_required}
          />
        );

      case "number":
        return (
          <Input
            id={field.field_key}
            type="number"
            value={value || ""}
            onChange={(e) => onChange(e.target.value || null)}
            placeholder={field.placeholder || undefined}
            disabled={disabled}
            required={field.is_required}
            min={field.validation_rules?.min}
            max={field.validation_rules?.max}
          />
        );

      case "date":
        return (
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal",
                  !value && "text-muted-foreground"
                )}
                disabled={disabled}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {value ? format(parseISO(value), "PPP") : field.placeholder || "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={value ? parseISO(value) : undefined}
                onSelect={(date) => {
                  onChange(date ? format(date, "yyyy-MM-dd") : null);
                  setDateOpen(false);
                }}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        );

      case "datetime":
        return (
          <div className="flex gap-2">
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "flex-1 justify-start text-left font-normal",
                    !value && "text-muted-foreground"
                  )}
                  disabled={disabled}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {value ? format(parseISO(value), "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={value ? parseISO(value) : undefined}
                  onSelect={(date) => {
                    const currentTime = value ? format(parseISO(value), "HH:mm") : "00:00";
                    onChange(date ? `${format(date, "yyyy-MM-dd")}T${currentTime}:00` : null);
                    setDateOpen(false);
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <Input
              type="time"
              className="w-32"
              value={value ? format(parseISO(value), "HH:mm") : ""}
              onChange={(e) => {
                const currentDate = value ? format(parseISO(value), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd");
                onChange(`${currentDate}T${e.target.value}:00`);
              }}
              disabled={disabled}
            />
          </div>
        );

      case "boolean":
        return (
          <div className="flex items-center space-x-2">
            <Checkbox
              id={field.field_key}
              checked={value === "true"}
              onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
              disabled={disabled}
            />
            <label
              htmlFor={field.field_key}
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              {field.placeholder || "Yes"}
            </label>
          </div>
        );

      case "select":
        return (
          <Select
            value={value || ""}
            onValueChange={(val) => onChange(val || null)}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder={field.placeholder || "Select an option"} />
            </SelectTrigger>
            <SelectContent>
              {(field.options || []).map((option: FieldOption) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.color && (
                    <span
                      className="inline-block w-3 h-3 rounded-full mr-2"
                      style={{ backgroundColor: option.color }}
                    />
                  )}
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case "multiselect": {
        const selectedValues = valueJson?.values as string[] || (value ? value.split(",") : []);
        return (
          <div className="space-y-2">
            <Select
              value=""
              onValueChange={(val) => {
                if (!selectedValues.includes(val)) {
                  const newValues = [...selectedValues, val];
                  onChange(newValues.join(","), { values: newValues });
                }
              }}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder={field.placeholder || "Add options..."} />
              </SelectTrigger>
              <SelectContent>
                {(field.options || [])
                  .filter((opt: FieldOption) => !selectedValues.includes(opt.value))
                  .map((option: FieldOption) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {selectedValues.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedValues.map((val) => {
                  const option = (field.options || []).find((o: FieldOption) => o.value === val);
                  return (
                    <Badge
                      key={val}
                      variant="secondary"
                      className="cursor-pointer"
                      style={option?.color ? { backgroundColor: option.color } : undefined}
                    >
                      {option?.label || val}
                      <X
                        className="ml-1 h-3 w-3"
                        onClick={() => {
                          if (!disabled) {
                            const newValues = selectedValues.filter((v) => v !== val);
                            onChange(newValues.join(",") || null, { values: newValues });
                          }
                        }}
                      />
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
        );
      }

      case "html":
        return (
          <RichTextWidget
            field={field}
            value={value}
            onChange={(val) => onChange(val)}
            disabled={disabled}
          />
        );

      case "file":
        return (
          <FileUploadWidget
            field={field}
            value={value}
            onChange={(val) => onChange(val)}
            disabled={disabled}
          />
        );

      case "related":
        return (
          <EntityLookupWidget
            field={field}
            value={value}
            onChange={(val) => onChange(val)}
            disabled={disabled}
          />
        );

      case "computed":
        return (
          <ComputedFieldWidget
            field={field}
            value={value}
          />
        );

      default:
        return (
          <Input
            id={field.field_key}
            value={value || ""}
            onChange={(e) => onChange(e.target.value || null)}
            placeholder={field.placeholder || undefined}
            disabled={disabled}
          />
        );
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-1">
        <Label htmlFor={field.field_key}>
          {field.field_label}
          {field.is_required && <span className="text-destructive ml-1">*</span>}
        </Label>
        {field.help_text && (
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{field.help_text}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {renderField()}
    </div>
  );
}
