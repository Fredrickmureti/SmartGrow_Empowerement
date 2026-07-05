/**
 * ContractsTemplatesPage — placeholder surface pointing operators at the
 * template model. The current schema stores template-like defaults on
 * `hr_policies` (default onboarding template + contract defaults); no
 * dedicated contract-template table exists. Rather than fake a CRUD, we
 * expose an accurate empty state and link to the HR Policies workspace,
 * consistent with the pack-driven / policy-driven architecture.
 */
import { Link } from "react-router-dom";
import { FileSignature, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, PageBody } from "@/design-system";

export default function ContractsTemplatesPage() {
  return (
    <>
      <PageHeader
        eyebrow="HR · Contracts"
        title="Contract templates"
        description="Reusable defaults for new contracts — wage schedule, working hours, probation. Configured through HR Policies."
      />
      <PageBody fullWidth>
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <FileSignature className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-sm font-medium">Templates live in HR Policies</div>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              Default probation months, notice days, working schedule, and onboarding
              template are managed at the policy layer so that every new contract
              inherits the same rules. Update policies to change the defaults for all
              future contracts.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/hr/employees/policies">
                Open HR Policies
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
