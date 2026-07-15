/**
 * MySettings — thin index page for `/me/settings`.
 *
 * The old MySettings embedded the workspace-user profile editor
 * (`UserProfilePage`) inline, which blurred the boundary between the
 * HR employee record and the user account. That inline editor has been
 * split off:
 *   - `/me/profile` — HR employee record + employee-managed personal
 *     contact fields (owned by `employees`).
 *   - `/me/account` — Identity & User Account: sign-in email, password,
 *     preferences (owned by `auth.users` + `profiles`).
 *
 * This page is now a lightweight hub that points users at the correct
 * surface for what they want to change. It is kept as `/me/settings`
 * for back-compat; the primary nav uses "Profile" and "Account".
 */
import { Link } from "react-router-dom";
import { ArrowRight, User as UserIcon, Bell, KeyRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader, PageBody } from "@/design-system";

const TILES = [
  {
    to: "/me/profile",
    label: "My profile",
    description: "HR record + personal contact details",
    Icon: UserIcon,
  },
  {
    to: "/me/account",
    label: "My account",
    description: "Sign-in, password, preferences",
    Icon: KeyRound,
  },
  {
    to: "/me/notifications",
    label: "Notifications",
    description: "Inbox and alert settings",
    Icon: Bell,
  },
];

export default function MySettings() {
  return (
    <>
      <PageHeader title="Settings" description="Manage your workspace profile and account." />
      <PageBody>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {TILES.map(({ to, label, description, Icon }) => (
            <Card key={to} className="p-0">
              <Link
                to={to}
                className="group flex items-start gap-3 p-4 hover:bg-accent rounded-lg transition-colors"
              >
                <div className="h-9 w-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  );
}
