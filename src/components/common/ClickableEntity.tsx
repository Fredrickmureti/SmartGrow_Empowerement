import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClickableEntityProps {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}

/**
 * Renders an entity name as interactive text with hover underline + subtle icon.
 * Used to replace dead-text entity references in detail dialogs and drawers.
 */
export function ClickableEntity({ children, onClick, className }: ClickableEntityProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 text-left text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded cursor-pointer transition-colors",
        className
      )}
    >
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
    </button>
  );
}
