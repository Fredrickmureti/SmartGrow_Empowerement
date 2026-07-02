/**
 * MeSubNav — grouped horizontal sub-nav for the /me/* portal.
 *
 * Mirrors AttendanceSubNav / LeaveSubNav / TimesheetsSubNav / EmployeesSubNav so
 * a portal user can move directly between Attendance · Timesheets · Time off ·
 * Shifts · Payslips · Documents · Loans · Profile / Onboarding / Exit /
 * Settings without round-tripping through the /me home tile screen.
 *
 * The MePortalLayout left rail covers full nav on desktop; this sub-nav adds
 * structured grouping with operations badges (own pending counts) and a
 * "More" dropdown for less-frequent destinations.
 */
import { NavLink } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEntitlementGate } from "@/hooks/useEntitlementGate";

interface Item {
  to: string;
  label: string;
  end?: boolean;
  badge?: number;
}
interface Group {
  label: string;
  items: Item[];
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

export function MeSubNav() {
  const payroll = useEntitlementGate("payroll", "read");
  const timesheets = useEntitlementGate("timesheets", "read");

  const operations: Item[] = [
    { to: "/me", label: "Home", end: true },
    { to: "/me/attendance", label: "Attendance" },
    ...(timesheets.allowed ? [{ to: "/me/timesheets", label: "Timesheets" }] : []),
    { to: "/me/leave", label: "Time off" },
    { to: "/me/shifts", label: "Shifts" },
  ];

  const records: Item[] = [
    { to: "/me/payslips", label: "Payslips" },
    ...(payroll.allowed ? [{ to: "/me/tax-certificates", label: "Tax certificates" }] : []),
    { to: "/me/documents", label: "Documents" },
    ...(payroll.allowed ? [{ to: "/me/loans", label: "Loans" }] : []),
  ];

  const groups: Group[] = [
    { label: "Operations", items: operations },
    { label: "Records", items: records },
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
              <span>Profile</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">My account</DropdownMenuLabel>
              <DropdownMenuItem asChild>
                <NavLink to="/me/profile">Profile</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/me/onboarding">Onboarding</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/me/exit">Exit clearance</NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/me/settings">Settings</NavLink>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

export default MeSubNav;
