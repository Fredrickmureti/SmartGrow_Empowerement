/**
 * Studio Quick Panel Trigger
 * 
 * A small button that opens the Studio Quick Panel for in-context
 * field customization. Only visible to admin/settings users.
 */
import { useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Wand2 } from "lucide-react";
import { StudioQuickPanel } from "./StudioQuickPanel";

interface StudioQuickPanelTriggerProps {
  entityType: string;
}

export function StudioQuickPanelTrigger({ entityType }: StudioQuickPanelTriggerProps) {
  const [open, setOpen] = useState(false);
  const permissions = usePermissions();

  // Only show for users who can edit settings (admin-level)
  if (!permissions.canEditSettings) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setOpen(true)}
          >
            <Wand2 className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Customize Fields
        </TooltipContent>
      </Tooltip>

      <StudioQuickPanel
        open={open}
        onOpenChange={setOpen}
        entityType={entityType}
      />
    </>
  );
}
