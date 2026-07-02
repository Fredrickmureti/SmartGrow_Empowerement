/**
 * LeaveSubNav — grouped, scannable navigation for the Time-off sub-app.
 *
 * Mirrors AttendanceSubNav. Approvals, Team calendar, and Allocations are now
 * real routes (no more ?tab=… single-page Tabs), so links are deep-linkable.
 */
import { NavLink } from "react-router-dom";
import { Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLeaveInboxCounts } from "@/hooks/leave/useLeaveInboxCounts";

interface Item {
  to: string;
  label: string;
  end?: boolean;
  badge?: number;
}
interface Group {
  label: string;
  items: Item[];
  badge?: number;
}

function NavItem({ item }: { item: Item }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
        )
      }
    >
      <span>{item.label}</span>
      {item.badge && item.badge > 0 ? (
        <Badge variant="destructive" className="h-4 min-w-[16px] px-1 text-[10px] leading-none">
          {item.badge > 99 ? "99+" : item.badge}
        </Badge>
      ) : null}
    </NavLink>
  );
}

export function LeaveSubNav() {
  const { counts } = useLeaveInboxCounts();
  const inbox = counts.total;

  const groups: Group[] = [
    {
      label: "Operations",
      items: [
        { to: "/hr/leave", label: "Overview", end: true },
        { to: "/hr/leave/calendar", label: "Team calendar" },
      ],
    },
    {
      label: "Inbox",
      badge: inbox,
      items: [{ to: "/hr/leave/approvals", label: "Approvals", badge: inbox }],
    },
  ];

  return (
    <div className="border-b mb-4 -mx-1 px-1">
      <div className="flex items-center gap-4 overflow-x-auto pb-2 scrollbar-thin">
        {groups.map((group, idx) => (
          <div key={group.label} className="flex items-center gap-1.5 shrink-0">
            {idx > 0 && <div className="h-5 w-px bg-border mx-1" aria-hidden />}
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium pr-1">
              {group.label}
            </span>
            {group.items.map((item) => (
              <NavItem key={item.to} item={item} />
            ))}
          </div>
        ))}

        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          <div className="h-5 w-px bg-border mx-1" aria-hidden />
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <SettingsIcon className="h-3.5 w-3.5" />
              <span>Setup</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Configuration</DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <NavLink to="/hr/leave/allocations">Allocations</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/hr/leave/types">Leave types</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/hr/leave/holidays">Public holidays</NavLink>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
