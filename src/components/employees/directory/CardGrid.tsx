import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { MapPin } from "lucide-react";
import type { Employee } from "@/hooks/useEmployees";
import { positionName, locationName } from "./helpers";
import { SetupHealthPill } from "./SetupHealthPill";
import type { SetupHealthRow } from "@/hooks/hr/useEmployeeSetupHealth";

export function CardGrid({
  employees, positions, locations, onOpen, rowActions,
  selectedIds, onToggleSelected, healthById,
}: {
  employees: Employee[];
  positions: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  onOpen: (e: Employee) => void;
  rowActions: (e: Employee) => React.ReactNode;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  healthById?: Map<string, SetupHealthRow>;
}) {

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
      {employees.map((e) => {
        const pos = positionName((e as any).job_position_id, positions) || e.position || "—";
        const loc = locationName((e as any).work_location_id, locations);
        const checked = selectedIds.has(e.id);
        return (
          <div
            key={e.id}
            className={`border rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer relative ${checked ? "ring-2 ring-primary" : ""}`}
            onClick={() => onOpen(e)}
          >
            <div className="absolute top-2 left-2" onClick={(ev) => ev.stopPropagation()}>
              <Checkbox checked={checked} onCheckedChange={() => onToggleSelected(e.id)} />
            </div>
            <div className="absolute top-2 right-2" onClick={(ev) => ev.stopPropagation()}>{rowActions(e)}</div>
            <div className="flex items-start gap-3 mt-4">
              <Avatar className="h-12 w-12">
                <AvatarImage src={(e as any).avatar_url || undefined} />
                <AvatarFallback>{e.first_name?.[0]}{e.last_name?.[0]}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{e.first_name} {e.last_name}</div>
                <div className="text-xs text-muted-foreground truncate">{pos}</div>
                <div className="text-xs text-muted-foreground truncate">{e.department_name || "—"}</div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5 flex-wrap">
              {loc && (
                <Badge variant="outline" className="text-xs gap-1">
                  <MapPin className="h-3 w-3" />{loc}
                </Badge>
              )}
              <Badge
                className={`text-xs ${e.is_active
                  ? "bg-success/10 text-success border-success/20"
                  : "bg-destructive/10 text-destructive border-destructive/20"}`}
                variant="outline"
              >
                {e.is_active ? "Active" : "Inactive"}
              </Badge>
              <SetupHealthPill row={healthById?.get(e.id)} compact />
            </div>
          </div>
        );
      })}
    </div>
  );
}