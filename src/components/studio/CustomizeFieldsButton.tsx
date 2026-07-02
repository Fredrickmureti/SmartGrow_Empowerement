import { Settings2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EntityType } from "@/hooks/useEntityFields";

interface CustomizeFieldsButtonProps {
  entityType: EntityType;
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  className?: string;
}

/**
 * In-app shortcut button that navigates to Studio > Fields
 * with the correct entity type pre-selected.
 */
export function CustomizeFieldsButton({
  entityType,
  variant = "ghost",
  size = "sm",
  className,
}: CustomizeFieldsButtonProps) {
  const navigate = useNavigate();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={className}
          onClick={() => navigate(`/studio?entity=${entityType}`)}
        >
          <Settings2 className="h-4 w-4 mr-1.5" />
          Customize Fields
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Open Studio to add or manage custom fields
      </TooltipContent>
    </Tooltip>
  );
}
