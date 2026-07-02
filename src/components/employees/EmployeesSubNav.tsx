/**
 * EmployeesSubNav — grouped navigation for the Employees foundation sub-app.
 *
 * Mirrors AttendanceSubNav / LeaveSubNav / TimesheetsSubNav so a user walking
 * across HR sub-apps gets one consistent mental model: Operations · Insights ·
 * Setup. Renders nothing on detail/edit screens that own their own chrome
 * (employee profile pages).
 */
import { NavLink, useLocation } from "react-router-dom";
import { Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Item {
  to: string;
  label: string;
  end?: boolean;
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
    </NavLink>
  );
}

export function EmployeesSubNav() {
  const { pathname } = useLocation();

  // Hide chrome on the employee profile route — that page owns its own header.
  if (/^\/hr\/employees\/[^/]+/.test(pathname)) return null;

  const groups: Group[] = [
    {
      label: "Operations",
      items: [
        { to: "/hr/dashboard", label: "Overview" },
        { to: "/hr/employees", label: "Directory", end: true },
        { to: "/hr/org-chart", label: "Org chart" },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/hr/reports", label: "Reports" },
        { to: "/hr/performance", label: "Performance" },
      ],
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
          <NavLink
            to="/hr/configuration"
            className={({ isActive }) =>
              cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )
            }
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            <span>Configuration</span>
          </NavLink>
        </div>
      </div>
    </div>
  );
}
