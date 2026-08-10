/**
 * DocumentActions — the one action vocabulary a business document has.
 *
 * A document declares its actions once (in a `use<Doc>Actions` hook) and both
 * surfaces render the same array: the list row menu and the record page
 * header. That is what stops the two from drifting — previously the row menu
 * carried a dozen actions the full page never offered, including Edit.
 *
 * Rendering contract:
 *   [ primary buttons (max 3, right-aligned) ]  [ ⋯ More ]
 * Destructive actions never surface as buttons; they sit at the bottom of the
 * overflow menu behind a separator.
 */
import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface DocumentAction {
  /** Stable id — also the parity key between the row menu and the page. */
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Not applicable to this record right now → omitted entirely. */
  hidden?: boolean;
  /** Applicable but not allowed right now → rendered greyed with a reason. */
  disabled?: boolean;
  /** Tooltip explaining a disabled action. */
  disabledReason?: string;
  /** Promote to a top-level button (max 3 win; the rest fall to overflow). */
  primary?: boolean;
  /** Destructive actions are always overflow-only, always last. */
  destructive?: boolean;
  /** Marks a divider point in the overflow menu. */
  group?: string;
}

export function visibleDocumentActions(actions: DocumentAction[] = []) {
  return actions.filter((a) => !a.hidden);
}

interface DocumentActionsBarProps {
  actions: DocumentAction[];
  /** How many non-destructive actions may render as buttons. */
  maxButtons?: number;
  className?: string;
  size?: "sm" | "default";
}

export function DocumentActionsBar({
  actions,
  maxButtons = 3,
  className,
  size = "sm",
}: DocumentActionsBarProps) {
  const visible = visibleDocumentActions(actions);
  if (visible.length === 0) return null;

  const promotable = visible.filter((a) => a.primary && !a.destructive);
  const buttons = promotable.slice(0, maxButtons);
  const buttonIds = new Set(buttons.map((a) => a.id));
  const overflow = visible.filter((a) => !buttonIds.has(a.id));
  const menuSafe = overflow.filter((a) => !a.destructive);
  const menuDestructive = overflow.filter((a) => a.destructive);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {buttons.map((action, idx) => {
        const Icon = action.icon;
        const isLast = idx === buttons.length - 1;
        return (
          <Button
            key={action.id}
            size={size}
            variant={isLast ? "default" : "outline"}
            onClick={action.onSelect}
            disabled={action.disabled}
            title={action.disabled ? action.disabledReason : undefined}
          >
            {Icon && <Icon className="mr-2 h-4 w-4" />}
            {action.label}
          </Button>
        );
      })}

      {(menuSafe.length > 0 || menuDestructive.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size={size} aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
              <span className="ml-2 hidden sm:inline">More</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {menuSafe.map((action, idx) => {
              const Icon = action.icon;
              const prev = menuSafe[idx - 1];
              const divider = !!prev && prev.group !== action.group;
              return (
                <div key={action.id}>
                  {divider && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onClick={action.onSelect}
                    disabled={action.disabled}
                    title={action.disabled ? action.disabledReason : undefined}
                  >
                    {Icon && <Icon className="mr-2 h-4 w-4" />}
                    {action.label}
                  </DropdownMenuItem>
                </div>
              );
            })}
            {menuDestructive.length > 0 && menuSafe.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {menuDestructive.map((action) => {
              const Icon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.id}
                  onClick={action.onSelect}
                  disabled={action.disabled}
                  title={action.disabled ? action.disabledReason : undefined}
                  className="text-destructive focus:text-destructive"
                >
                  {Icon && <Icon className="mr-2 h-4 w-4" />}
                  {action.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Row-menu projection of the same array (list tables). */
export function DocumentActionsMenu({
  actions,
  align = "end",
  trigger,
}: {
  actions: DocumentAction[];
  align?: "start" | "end";
  trigger?: React.ReactNode;
}) {
  const visible = visibleDocumentActions(actions);
  if (visible.length === 0) return null;
  const safe = visible.filter((a) => !a.destructive);
  const destructive = visible.filter((a) => a.destructive);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon" aria-label="Row actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        {safe.map((action, idx) => {
          const Icon = action.icon;
          const prev = safe[idx - 1];
          const divider = !!prev && prev.group !== action.group;
          return (
            <div key={action.id}>
              {divider && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={action.onSelect}
                disabled={action.disabled}
                title={action.disabled ? action.disabledReason : undefined}
              >
                {Icon && <Icon className="mr-2 h-4 w-4" />}
                {action.label}
              </DropdownMenuItem>
            </div>
          );
        })}
        {destructive.length > 0 && safe.length > 0 && <DropdownMenuSeparator />}
        {destructive.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              key={action.id}
              onClick={action.onSelect}
              disabled={action.disabled}
              className="text-destructive focus:text-destructive"
            >
              {Icon && <Icon className="mr-2 h-4 w-4" />}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
