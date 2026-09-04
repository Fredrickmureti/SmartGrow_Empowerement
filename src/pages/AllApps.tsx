/**
 * All Apps — the launcher surface reached from the "All apps" rail button.
 *
 * Mirrors Home's composition (DashboardAppLayout + PageHeader + PageBody)
 * so it inherits the same chrome, density, and theme tokens.
 */

import { DashboardAppLayout } from "@/apps/dashboard";
import { AppLauncher } from "@/components/home/AppLauncher";
import { PageHeader, PageBody, Section } from "@/design-system";

export default function AllApps() {
  return (
    <DashboardAppLayout>
      <PageHeader
        title="All apps"
        description="Every workspace available to you. Open one to get started."
      />
      <PageBody>
        <Section title="Apps" unstyled>
          <AppLauncher />
        </Section>
      </PageBody>
    </DashboardAppLayout>
  );
}
