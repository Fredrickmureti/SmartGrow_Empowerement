import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, X, UserCheck, UserX } from "lucide-react";

export interface BulkActions {
  onSetManager: () => void;
  onSetDepartment: () => void;
  onSetWorkLocation: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onClear: () => void;
}

export function BulkActionBar({
  count,
  actions,
  canManage,
}: {
  count: number;
  actions: BulkActions;
  canManage: boolean;
}) {
  if (count === 0 || !canManage) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-muted/40 border rounded-md">
      <div className="text-sm">
        <span className="font-medium">{count}</span> selected
      </div>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Bulk actions <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={actions.onSetManager}>Set manager…</DropdownMenuItem>
            <DropdownMenuItem onClick={actions.onSetDepartment}>Set department…</DropdownMenuItem>
            <DropdownMenuItem onClick={actions.onSetWorkLocation}>Set work location…</DropdownMenuItem>
            <DropdownMenuItem onClick={actions.onActivate}>
              <UserCheck className="mr-2 h-4 w-4" />Activate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={actions.onDeactivate} className="text-destructive">
              <UserX className="mr-2 h-4 w-4" />Deactivate
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={actions.onClear}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}