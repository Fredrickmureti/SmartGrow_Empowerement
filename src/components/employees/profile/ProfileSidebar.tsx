/**
 * Sticky left-rail navigation for the employee profile hub.
 * Replaces the 9 horizontal tabs with a vertical, scannable section list.
 */
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

export interface ProfileSection {
  id: string;
  label: string;
  icon: LucideIcon;
  group?: "main" | "hr" | "admin";
  visible: boolean;
}

interface Props {
  sections: ProfileSection[];
  active: string;
  onSelect: (id: string) => void;
}

export function ProfileSidebar({ sections, active, onSelect }: Props) {
  const visible = sections.filter((s) => s.visible);
  const groups = [
    { key: "main", label: "Profile" },
    { key: "hr", label: "HR" },
    { key: "admin", label: "Admin" },
  ] as const;

  return (
    <nav className="w-full md:w-56 md:sticky md:top-4 self-start shrink-0">
      <div className="md:hidden mb-3">
        <select
          value={active}
          onChange={(e) => onSelect(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {visible.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
      <div className="hidden md:block space-y-4">
        {groups.map((g) => {
          const items = visible.filter((s) => (s.group || "main") === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="px-3 mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {g.label}
              </div>
              <ul className="space-y-0.5">
                {items.map((s) => {
                  const Icon = s.icon;
                  const isActive = s.id === active;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(s.id)}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{s.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
