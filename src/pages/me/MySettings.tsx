/**
 * MySettings — portal-user-safe settings page at `/me/settings`.
 *
 * Replaces the generic `/settings` hub for portal users. Exposes ONLY
 * self-service surfaces: account profile (name, phone, avatar) and a
 * link into the HR employee profile when one exists. No Apps panel,
 * no Subscriptions, no Billing, no Admin Management, no organization
 * switcher, no Studio, no Audit Logs.
 *
 * Internal users land here too if they navigate to `/me/settings`
 * directly, but they can still reach the full Settings hub via
 * `/settings/workspace` from the business shell. This page is the
 * canonical settings surface inside the My Workspace portal.
 */

import { Link } from "react-router-dom";
import { ArrowRight, User as UserIcon, Bell, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import UserProfilePage from "@/pages/settings/UserProfilePage";
import { PageHeader, PageBody } from "@/design-system";

export default function MySettings() {
  return (
    <>
      <PageHeader title="Settings" description="Your account profile and personal preferences." />
      <PageBody>
      {/* Quick links to related self-service surfaces */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link
          to="/me/profile"
          className="group rounded-lg border bg-card p-4 hover:bg-accent transition-colors flex items-start gap-3"
        >
          <div className="h-9 w-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <UserIcon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">My HR profile</p>
            <p className="text-xs text-muted-foreground">Employment details</p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>
        <Link
          to="/notifications"
          className="group rounded-lg border bg-card p-4 hover:bg-accent transition-colors flex items-start gap-3"
        >
          <div className="h-9 w-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Bell className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Notifications</p>
            <p className="text-xs text-muted-foreground">Inbox &amp; alerts</p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>
        <a
          href="https://supabase.com/dashboard"
          onClick={(e) => e.preventDefault()}
          className="group rounded-lg border bg-card p-4 opacity-50 cursor-not-allowed flex items-start gap-3"
          title="Contact your administrator to reset your password"
        >
          <div className="h-9 w-9 rounded-md bg-muted text-muted-foreground flex items-center justify-center shrink-0">
            <Lock className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Password</p>
            <p className="text-xs text-muted-foreground">Contact your admin</p>
          </div>
        </a>
      </div>

      {/* Profile editor — uses the existing account profile page,
          which is portal-safe (no business-app affordances). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account profile</CardTitle>
          <CardDescription>Name, phone and avatar shown across the workspace.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <UserProfilePage />
        </CardContent>
      </Card>
      </PageBody>
    </>
  );
}