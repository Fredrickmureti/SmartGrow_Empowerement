import { PlatformAppLayout } from "@/apps/platform";
import { ComplianceDashboard } from "@/components/reports/ComplianceDashboard";

export default function Compliance() {
  return (
    <PlatformAppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Compliance & Checklist</h1>
          <p className="text-muted-foreground">
            Track regulatory compliance, tax deadlines, and recurring business requirements
          </p>
        </div>
        <ComplianceDashboard />
      </div>
    </PlatformAppLayout>
  );
}

