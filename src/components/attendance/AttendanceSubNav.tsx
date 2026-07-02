/**
 * AttendanceSubNav — grouped, scannable navigation for the HR Attendance sub-app.
 *
 * Replaces the 10-flat-tab nav with three semantic groups (Operations, Approvals,
 * Insights) and a Setup dropdown. Surfaces a unified pending-work badge on the
 * Approvals group and on Setup → Devices.
 *
 * Mobile: collapses to a single horizontal scroller with section dividers.
 */
import { NavLink, useLocation } from "react-router-dom";
import { ExternalLink, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAttendanceInboxCounts } from "@/hooks/hr/useAttendanceInboxCounts";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";

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

export function AttendanceSubNav() {
  const { pathname } = useLocation();
  const { counts } = useAttendanceInboxCounts();
  const { isManager } = useCurrentEmployee();

  // Chrome-less kiosk: hide sub-nav entirely
  if (pathname.includes("/attendance/kiosk")) return null;

  const approvalsBadge = counts.corrections + counts.overtime;

  // B1: "My Team" collapsed into Today via ?scope=team (single page, one mental model)
  // B3: "Approvals" group → "Inbox"; "Audit" → "Activity log" (industry-standard terms)
  const groups: Group[] = [
    {
      label: "Operations",
      items: [
        { to: "/hr/attendance", label: "Today", end: true },
        { to: "/hr/attendance/roster", label: "Roster" },
        { to: "/hr/attendance/shifts", label: "Shifts" },
      ],
    },
    {
      label: "Inbox",
      badge: approvalsBadge,
      items: [
        { to: "/hr/attendance/approvals", label: "Approvals", badge: approvalsBadge },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/hr/attendance/reports", label: "Reports" },
        { to: "/hr/attendance/audit", label: "Activity log" },
      ],
    },
  ];
  // isManager retained for future use; the My-Team chip lives on Today.
  void isManager;

  const openKiosk = () => {
    window.open("/kiosk/attendance", "_blank", "noopener,noreferrer");
  };

  return (
    <div className="border-b mb-4 -mx-1 px-1">
      <div className="flex items-center gap-4 overflow-x-auto pb-2 scrollbar-thin">
        {groups.map((group, idx) => (
          <div key={group.label} className="flex items-center gap-1.5 shrink-0">
            {idx > 0 && <div className="h-5 w-px bg-border mx-1" aria-hidden />}
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium pr-1">
              {group.label}
              {group.badge && group.badge > 0 ? (
                <Badge variant="destructive" className="ml-1.5 h-4 min-w-[16px] px-1 text-[10px] leading-none">
                  {group.badge > 99 ? "99+" : group.badge}
                </Badge>
              ) : null}
            </span>
            {group.items.map((item) => (
              <NavItem key={item.to} item={item} />
            ))}
          </div>
        ))}

        {/* Setup dropdown */}
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
              {counts.devicesDisabled > 0 && (
                <Badge variant="destructive" className="h-4 min-w-[16px] px-1 text-[10px] leading-none">
                  {counts.devicesDisabled}
                </Badge>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Configuration</DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <NavLink to="/hr/attendance/settings">Settings</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/hr/attendance/devices">
                  <span>Devices</span>
                </NavLink>
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Modes</DropdownMenuLabel>
              <DropdownMenuItem onClick={openKiosk} className="cursor-pointer">
                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                Open Kiosk
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
