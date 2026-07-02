import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SavedView } from "@/hooks/useSavedViews";
import { Loader2 } from "lucide-react";

interface KanbanConfig {
  group_by: string;
  columns?: Array<{ id: string; label: string; color?: string }>;
  card_title_field?: string;
  card_subtitle_field?: string;
  card_badge_field?: string;
}

interface DynamicKanbanViewProps<T extends Record<string, unknown>> {
  view: SavedView;
  data: T[];
  isLoading?: boolean;
  onCardClick?: (item: T) => void;
  renderCard?: (item: T) => React.ReactNode;
}

export function DynamicKanbanView<T extends Record<string, unknown>>({
  view,
  data,
  isLoading,
  onCardClick,
  renderCard,
}: DynamicKanbanViewProps<T>) {
  const config = view.view_config as unknown as KanbanConfig;

  const groupedData = useMemo(() => {
    if (!config?.group_by) return {};
    
    const groups: Record<string, T[]> = {};
    
    if (config.columns) {
      config.columns.forEach((col) => {
        groups[col.id] = [];
      });
    }
    
    data.forEach((item) => {
      const groupValue = String(item[config.group_by] ?? "undefined");
      if (!groups[groupValue]) {
        groups[groupValue] = [];
      }
      groups[groupValue].push(item);
    });
    
    return groups;
  }, [data, config?.group_by, config?.columns]);

  const columns = useMemo(() => {
    if (config?.columns) {
      return config.columns;
    }
    return Object.keys(groupedData).map((key) => ({
      id: key,
      label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
    }));
  }, [config?.columns, groupedData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {columns.map((column) => (
        <div key={column.id} className="flex-shrink-0 w-72 bg-muted/50 rounded-lg">
          <div className="p-3 border-b bg-muted rounded-t-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-sm">{column.label}</h3>
              <Badge variant="secondary" className="text-xs">
                {groupedData[column.id]?.length ?? 0}
              </Badge>
            </div>
          </div>
          <ScrollArea className="h-[calc(100vh-280px)]">
            <div className="p-2 space-y-2">
              {groupedData[column.id]?.map((item, index) => (
                <Card
                  key={String(item.id) || index}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => onCardClick?.(item)}
                >
                  {renderCard ? renderCard(item) : (
                    <CardContent className="p-3">
                      <p className="font-medium text-sm">
                        {String(item[config?.card_title_field || "name"] ?? item.id)}
                      </p>
                    </CardContent>
                  )}
                </Card>
              ))}
            </div>
          </ScrollArea>
        </div>
      ))}
    </div>
  );
}
