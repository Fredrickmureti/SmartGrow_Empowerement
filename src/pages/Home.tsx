/**
 * Home Page — Dashboard workspace launcher surface.
 *
 * Renders inside `DashboardAppLayout` (PlatformShell) and composes from
 * `PageHeader` + `PageBody` + `Section` so it follows the same vertical
 * rhythm, chrome, and density as every other authenticated page. No
 * bespoke wrappers, no per-page max-width math.
 */

import { DashboardAppLayout } from "@/apps/dashboard";
import { AppLauncher } from "@/components/home/AppLauncher";
import { QuickStats } from "@/components/home/QuickStats";
import { QuickActions } from "@/components/home/QuickActions";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { getDisplayName } from "@/lib/user-display-name";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { LayoutDashboard, ArrowRight } from "lucide-react";
import { PageHeader, PageBody, Section } from "@/design-system";

export default function Home() {
  const { isLoading } = useSession();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();

  const { firstName } = getDisplayName(currentEmployee, profile, user);
  const companyName = currentBusiness?.name;

  const title = `${firstName ? `${firstName}, ` : ""}Welcome back${
    companyName ? `, ${companyName}` : ""
  }`;

  return (
    <DashboardAppLayout>
      <PageHeader
        title={title}
        description="Your apps and shortcuts. Open the command center for today's operations."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard">
              <LayoutDashboard className="h-4 w-4" />
              Open command center
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        }
      />
      <PageBody>
        <Section title="Quick actions" unstyled>
          <QuickActions />
        </Section>
        <Section title="Business at a glance" unstyled>
          <QuickStats isLoading={isLoading} />
        </Section>
        <Section title="Apps" unstyled>
          <AppLauncher />
        </Section>
      </PageBody>
    </DashboardAppLayout>
  );
}
