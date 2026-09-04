import { useState, useMemo } from "react";
import { ViewType, ViewConfig, ListViewConfig, KanbanViewConfig, ChartViewConfig, PivotViewConfig, CalendarViewConfig, GanttViewConfig, ColumnConfig, SortConfig } from "@/hooks/useSavedViews";
import { useAllEntityFields, EntityType, ENTITY_TYPE_LABELS, EntityFieldConfig } from "@/hooks/useEntityFields";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

// Built-in core fields per entity type (microfinance catalogue)
import { CORE_FIELDS } from "@/lib/studio/entities";


interface ViewConfigPanelProps {
  viewType: ViewType;
  entityType: EntityType | string;
  config: ViewConfig;
  onChange: (config: ViewConfig) => void;
}

export function ViewConfigPanel({ viewType, entityType, config, onChange }: ViewConfigPanelProps) {
  const { getFieldsForEntityType } = useAllEntityFields();
  const customFields = getFieldsForEntityType(entityType as EntityType);

  const allFields = useMemo(() => {
    const core = CORE_FIELDS[entityType] || [];
    const custom = customFields.map(f => ({ field: f.field_key, label: f.field_label }));
    return [...core, ...custom];
  }, [entityType, customFields]);

  switch (viewType) {
    case "list":
      return <ListConfig config={config as ListViewConfig} onChange={onChange} fields={allFields} />;
    case "kanban":
      return <KanbanConfig config={config as KanbanViewConfig} onChange={onChange} fields={allFields} />;
    case "chart":
      return <ChartConfig config={config as ChartViewConfig} onChange={onChange} fields={allFields} />;
    case "pivot":
      return <PivotConfig config={config as PivotViewConfig} onChange={onChange} fields={allFields} />;
    case "calendar":
      return <CalendarConfig config={config as CalendarViewConfig} onChange={onChange} fields={allFields} />;
    case "gantt":
      return <GanttConfig config={config as GanttViewConfig} onChange={onChange} fields={allFields} />;
    default:
      return null;
  }
}

// === List Config ===
function ListConfig({ config, onChange, fields }: { config: ListViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  const columns = config.columns || [];
  const columnMap = new Map(columns.map(c => [c.field, c]));

  const toggleColumn = (field: string, label: string) => {
    if (columnMap.has(field)) {
      onChange({ ...config, columns: columns.filter(c => c.field !== field) });
    } else {
      onChange({ ...config, columns: [...columns, { field, label, visible: true }] });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Visible Columns</Label>
        <p className="text-xs text-muted-foreground mb-2">Select which columns to show in the list view</p>
        <ScrollArea className="h-[200px]">
          <div className="space-y-1">
            {fields.map(f => (
              <div key={f.field} className="flex items-center gap-2 py-1">
                <Checkbox
                  checked={columnMap.has(f.field)}
                  onCheckedChange={() => toggleColumn(f.field, f.label)}
                  id={`col-${f.field}`}
                />
                <label htmlFor={`col-${f.field}`} className="text-sm cursor-pointer">{f.label}</label>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      <Separator />

      <div>
        <Label className="text-sm font-medium">Default Sort</Label>
        <div className="flex gap-2 mt-1">
          <Select
            value={config.sort?.field || ""}
            onValueChange={(v) => onChange({ ...config, sort: { field: v, direction: config.sort?.direction || "asc" } })}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Sort by..." />
            </SelectTrigger>
            <SelectContent>
              {fields.map(f => (
                <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={config.sort?.direction || "asc"}
            onValueChange={(v) => onChange({ ...config, sort: { field: config.sort?.field || fields[0]?.field || "", direction: v as "asc" | "desc" } })}
          >
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">Ascending</SelectItem>
              <SelectItem value="desc">Descending</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium">Group By</Label>
        <Select
          value={config.groupBy || "__none__"}
          onValueChange={(v) => onChange({ ...config, groupBy: v === "__none__" ? undefined : v })}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {fields.map(f => (
              <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// === Kanban Config ===
function KanbanConfig({ config, onChange, fields }: { config: KanbanViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Group By Field *</Label>
        <p className="text-xs text-muted-foreground mb-1">Field used to create kanban columns (e.g., Status, Stage)</p>
        <Select
          value={config.groupBy || ""}
          onValueChange={(v) => onChange({ ...config, groupBy: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select field..." />
          </SelectTrigger>
          <SelectContent>
            {fields.map(f => (
              <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-sm font-medium">Card Fields</Label>
        <p className="text-xs text-muted-foreground mb-2">Fields shown on each kanban card</p>
        <ScrollArea className="h-[160px]">
          <div className="space-y-1">
            {fields.map(f => (
              <div key={f.field} className="flex items-center gap-2 py-1">
                <Checkbox
                  checked={(config.cardFields || []).includes(f.field)}
                  onCheckedChange={(checked) => {
                    const current = config.cardFields || [];
                    const updated = checked ? [...current, f.field] : current.filter(x => x !== f.field);
                    onChange({ ...config, cardFields: updated });
                  }}
                  id={`card-${f.field}`}
                />
                <label htmlFor={`card-${f.field}`} className="text-sm cursor-pointer">{f.label}</label>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// === Chart Config ===
function ChartConfig({ config, onChange, fields }: { config: ChartViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  const chartTypes = [
    { value: "bar", label: "Bar" },
    { value: "line", label: "Line" },
    { value: "pie", label: "Pie" },
    { value: "doughnut", label: "Doughnut" },
    { value: "area", label: "Area" },
    { value: "scatter", label: "Scatter" },
  ] as const;

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Chart Type</Label>
        <Select
          value={config.type || "bar"}
          onValueChange={(v) => onChange({ ...config, type: v as ChartViewConfig["type"] })}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {chartTypes.map(t => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-sm font-medium">X-Axis Field</Label>
        <Select value={config.xAxis || ""} onValueChange={(v) => onChange({ ...config, xAxis: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-sm font-medium">Y-Axis Field</Label>
        <Select value={config.yAxis || ""} onValueChange={(v) => onChange({ ...config, yAxis: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-sm font-medium">Group By (Optional)</Label>
        <Select value={config.groupBy || "__none__"} onValueChange={(v) => onChange({ ...config, groupBy: v === "__none__" ? undefined : v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// === Pivot Config ===
function PivotConfig({ config, onChange, fields }: { config: PivotViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  const aggregations = ["sum", "count", "avg", "min", "max"] as const;

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Row Fields</Label>
        <p className="text-xs text-muted-foreground mb-2">Fields to group rows by</p>
        <ScrollArea className="h-[120px]">
          <div className="space-y-1">
            {fields.map(f => (
              <div key={f.field} className="flex items-center gap-2 py-1">
                <Checkbox
                  checked={(config.rows || []).includes(f.field)}
                  onCheckedChange={(checked) => {
                    const updated = checked ? [...(config.rows || []), f.field] : (config.rows || []).filter(x => x !== f.field);
                    onChange({ ...config, rows: updated });
                  }}
                  id={`row-${f.field}`}
                />
                <label htmlFor={`row-${f.field}`} className="text-sm cursor-pointer">{f.label}</label>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div>
        <Label className="text-sm font-medium">Column Fields</Label>
        <ScrollArea className="h-[120px]">
          <div className="space-y-1">
            {fields.map(f => (
              <div key={f.field} className="flex items-center gap-2 py-1">
                <Checkbox
                  checked={(config.cols || []).includes(f.field)}
                  onCheckedChange={(checked) => {
                    const updated = checked ? [...(config.cols || []), f.field] : (config.cols || []).filter(x => x !== f.field);
                    onChange({ ...config, cols: updated });
                  }}
                  id={`col-${f.field}`}
                />
                <label htmlFor={`col-${f.field}`} className="text-sm cursor-pointer">{f.label}</label>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div>
        <Label className="text-sm font-medium">Value Field</Label>
        <div className="flex gap-2 mt-1">
          <Select
            value={(config.values || [])[0]?.field || ""}
            onValueChange={(v) => onChange({ ...config, values: [{ field: v, aggregate: (config.values || [])[0]?.aggregate || "sum" }] })}
          >
            <SelectTrigger className="flex-1"><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={(config.values || [])[0]?.aggregate || "sum"}
            onValueChange={(v) => onChange({ ...config, values: [{ field: (config.values || [])[0]?.field || "", aggregate: v as any }] })}
          >
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {aggregations.map(a => <SelectItem key={a} value={a}>{a.toUpperCase()}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

// === Calendar Config ===
function CalendarConfig({ config, onChange, fields }: { config: CalendarViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Date Field *</Label>
        <Select value={config.dateField || ""} onValueChange={(v) => onChange({ ...config, dateField: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">End Date Field (Optional)</Label>
        <Select value={config.endDateField || "__none__"} onValueChange={(v) => onChange({ ...config, endDateField: v === "__none__" ? undefined : v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">Title Field *</Label>
        <Select value={config.titleField || ""} onValueChange={(v) => onChange({ ...config, titleField: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">Color Field (Optional)</Label>
        <Select value={config.colorField || "__none__"} onValueChange={(v) => onChange({ ...config, colorField: v === "__none__" ? undefined : v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// === Gantt Config ===
function GanttConfig({ config, onChange, fields }: { config: GanttViewConfig; onChange: (c: ViewConfig) => void; fields: { field: string; label: string }[] }) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Start Date Field *</Label>
        <Select value={config.startField || ""} onValueChange={(v) => onChange({ ...config, startField: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">End Date Field *</Label>
        <Select value={config.endField || ""} onValueChange={(v) => onChange({ ...config, endField: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">Name/Title Field *</Label>
        <Select value={config.nameField || ""} onValueChange={(v) => onChange({ ...config, nameField: v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-sm font-medium">Progress Field (Optional)</Label>
        <Select value={config.progressField || "__none__"} onValueChange={(v) => onChange({ ...config, progressField: v === "__none__" ? undefined : v })}>
          <SelectTrigger className="mt-1"><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {fields.map(f => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
