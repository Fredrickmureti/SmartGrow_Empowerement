/**
 * MeHome — landing for `/me`
 *
 * The first thing staff see when they open "My Workspace". Surfaces:
 *   - Greeting with the employee's name
 *   - Quick-action tiles (Onboarding, Documents, Profile, Settings)
 *
 * Leave / timesheet / attendance self-service was removed with the HR
 * excision — this workspace is scoped to identity, documents and onboarding.
 */

import { Link } from "react-router-dom";
import {
  ClipboardList,
  FileText,
  Settings as SettingsIcon,
  User as UserIcon,
  ArrowRight,
} from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useAuth } from "@/contexts/AuthContext";

interface QuickActionDef {
  to: string;
  label: string;
  description: string;
  icon: typeof FileText;
}

const QUICK_ACTIONS: QuickActionDef[] = [
  { to: "/me/onboarding", label: "Onboarding", description: "New-hire checklist & tasks", icon: ClipboardList },
  { to: "/me/documents", label: "Documents", description: "Contracts, IDs, certifications", icon: FileText },
  { to: "/me/profile", label: "My profile", description: "Personal & employment details", icon: UserIcon },
  { to: "/me/settings", label: "Settings", description: "Preferences & notifications", icon: SettingsIcon },
];

function QuickActionTile({ action }: { action: QuickActionDef }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className="group rounded-lg border bg-card p-4 hover:bg-accent hover:border-accent-foreground/20 transition-colors flex items-start gap-3"
    >
      <div className="h-10 w-10 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{action.label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{action.description}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

export default function MeHome() {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();

  const greetingName =
    currentEmployee?.first_name ||
    (user?.user_metadata?.full_name as string | undefined)?.split(" ")[0] ||
    "there";

  return (
    <>
      <PageHeader
        title={`Hi ${greetingName} 👋`}
        description="Your workspace — documents, onboarding and personal details in one place."
      />
      <PageBody>
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Quick actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {QUICK_ACTIONS.map((a) => (
              <QuickActionTile key={a.to} action={a} />
            ))}
          </div>
        </section>
      </PageBody>
    </>
  );
}
