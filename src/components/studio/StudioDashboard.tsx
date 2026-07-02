import { Card, CardContent } from "@/components/ui/card";
import { useAllEntityFields, ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { useSavedViews } from "@/hooks/useSavedViews";
import { useFormLayouts } from "@/hooks/useFormLayouts";
import { Wand2, LayoutGrid, BarChart3, FileText, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface StudioDashboardProps {
  entityType: EntityType;
}

export function StudioDashboard({ entityType }: StudioDashboardProps) {
  const { getFieldCountByEntityType, isLoading: fieldsLoading } = useAllEntityFields();
  const { views, isLoading: viewsLoading } = useSavedViews(entityType);
  const { layouts, isLoading: layoutsLoading } = useFormLayouts(entityType);

  const isLoading = fieldsLoading || viewsLoading || layoutsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading summary…
      </div>
    );
  }

  const fieldCounts = getFieldCountByEntityType();
  const fieldCount = fieldCounts[entityType] ?? 0;
  const viewCount = views.length;
  const layoutCount = layouts.length;

  const stats = [
    { label: "Custom Fields", count: fieldCount, icon: Wand2 },
    { label: "Saved Views", count: viewCount, icon: BarChart3 },
    { label: "Form Layouts", count: layoutCount, icon: LayoutGrid },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map(({ label, count, icon: Icon }) => (
        <Card key={label} className="border-dashed">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Icon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-none">{count}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
